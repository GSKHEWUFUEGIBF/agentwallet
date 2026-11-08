import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgent } from './src/agent.js';
import { createPayPal } from './src/paypal.js';
import { CATALOG } from './src/catalog.js';
import { createStore } from './src/store.js';
import { createWalletService, HttpError } from './src/wallet.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function friendlyAgentError(err) {
  if (err?.name === 'AbortError' || err?.name === 'APIUserAbortError') return 'The run was cancelled.';
  if (err?.status === 401) return 'Anthropic rejected the API key. Check ANTHROPIC_API_KEY.';
  if (err?.status === 429) return 'Anthropic is rate limiting this key. Wait a minute and try again.';
  return 'The agent stopped because of an error. Nothing further was bought.';
}

export function createApp({ env = process.env, dataDir = env.DATA_DIR ?? path.join(here, 'data') } = {}) {
  const store = createStore(dataDir);
  const paypal = createPayPal(env);
  const wallet = createWalletService({ store, paypal });
  const agent = createAgent({ wallet, env });

  // Owner key: the routes that move money or change rules need it whenever it is set.
  // Real PayPal credentials without a key would let any stranger spend the wallet, so refuse to start.
  const ownerKey = env.OWNER_KEY ? String(env.OWNER_KEY) : '';
  if (paypal.mode === 'sandbox' && !ownerKey) {
    throw new Error('Set OWNER_KEY when PayPal credentials are configured, so only you can move money.');
  }
  if (paypal.mode === 'sandbox' && !env.PUBLIC_URL) {
    throw new Error('Set PUBLIC_URL (for example http://localhost:3000) so PayPal returns to the right address.');
  }
  const sameKey = (given) => {
    const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
    const b = crypto.createHash('sha256').update(ownerKey).digest();
    return crypto.timingSafeEqual(a, b);
  };
  const owner = (req, res, next) => {
    if (!ownerKey || sameKey(req.get('x-owner-key'))) return next();
    res.status(401).json({ error: 'Enter the owner key to do this.', needsOwnerKey: true });
  };

  const app = express();
  // Only believe X-Forwarded-For when told a proxy is in front (TRUST_PROXY=1, as on Render).
  // Otherwise anyone could pick their own address and dodge the per-visitor limit.
  app.set('trust proxy', /^\d+$/.test(env.TRUST_PROXY ?? '') ? Number(env.TRUST_PROXY) : false);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=15552000',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; form-action 'self' https://www.sandbox.paypal.com",
    });
    next();
  });

  // Browsers attach Origin to cross-site POSTs. Refuse any that do not come from this site.
  app.use('/api', (req, res, next) => {
    const o = req.get('origin');
    if (req.method === 'GET' || !o) return next();
    const allowed = [req.get('host'), env.PUBLIC_URL && new URL(env.PUBLIC_URL).host].filter(Boolean);
    try {
      if (allowed.includes(new URL(o).host)) return next();
    } catch {
      /* fall through */
    }
    res.status(403).json({ error: 'Cross-site requests are not allowed.' });
  });

  app.get('/favicon.ico', (req, res) => res.status(204).end()); // the page carries its own inline icon
  app.use(express.static(path.join(here, 'public')));

  // --- state and rules ---------------------------------------------------
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // One snapshot of everything the page needs, including how this server is configured.
  const snapshot = () => {
    const s = wallet.getState();
    return { ...s, modes: { ...s.modes, ai: agent.mode, model: agent.model, resetEnabled: env.ALLOW_RESET === '1', ownerKeyRequired: Boolean(ownerKey) } };
  };

  app.get('/api/state', (req, res) => res.json(snapshot()));
  // The demo store the agent shops in. Public: it is fictional and contains no secrets.
  app.get('/api/catalog', (req, res) => res.json({ items: CATALOG }));

  app.put('/api/rules', owner, (req, res) => {
    wallet.updateRules(req.body);
    res.json(snapshot());
  });

  // --- adding funds through PayPal --------------------------------------
  // Always use PUBLIC_URL when set; the Host header is only trusted in mock mode.
  const origin = (req) => (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

  app.post('/api/topup', owner, async (req, res) => {
    const { approveUrl } = await wallet.startTopup(req.body?.amountCents, {
      returnUrl: `${origin(req)}/topup/return`,
      cancelUrl: `${origin(req)}/topup/cancel`,
    });
    res.json({ approveUrl });
  });

  app.get('/topup/return', async (req, res) => {
    try {
      const topup = await wallet.completeTopup(String(req.query.token ?? ''));
      res.redirect(`/?topup=${topup.status === 'completed' ? 'success' : 'failed'}`);
    } catch (err) {
      res.redirect(err?.status === 502 ? `/?topup=retry&token=${encodeURIComponent(String(req.query.token ?? ''))}` : '/?topup=failed');
    }
  });

  app.get('/topup/cancel', async (req, res) => {
    await wallet.cancelTopup(String(req.query.token ?? ''));
    res.redirect('/?topup=cancelled');
  });

  // A stand-in for PayPal's approval page, used only in mock mode.
  app.get('/mock/paypal/approve', (req, res) => {
    if (paypal.mode !== 'mock') return res.status(404).send('Not found');
    const token = String(req.query.token ?? '');
    const topup = wallet.getState().topups.find((t) => t.orderId === token && t.status === 'pending');
    if (!topup) return res.status(404).send('No pending payment for this link.');
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock PayPal checkout</title>
<link rel="stylesheet" href="/styles.css"></head><body class="mock-page"><main class="mock-box">
<h1>Mock PayPal checkout</h1>
<p>This stands in for PayPal's approval page because no sandbox credentials are set. No money moves.</p>
<p class="mock-amount">Pay $${(topup.amountCents / 100).toFixed(2)} to AgentWallet</p>
<form method="get" action="/topup/return"><input type="hidden" name="token" value="${escapeHtml(token)}">
<button class="primary" type="submit">Approve payment</button></form>
<form method="get" action="/topup/cancel"><input type="hidden" name="token" value="${escapeHtml(token)}">
<button class="quiet" type="submit">Cancel</button></form>
</main></body></html>`);
  });

  // --- the agent ---------------------------------------------------------
  const runLog = new Map(); // ip -> timestamps of recent agent runs
  let activeRuns = 0;
  const perHour = Number(env.AGENT_RUNS_PER_HOUR ?? 20);
  function overLimit(ip) {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, v] of runLog) if (!v.some((t) => t > cutoff)) runLog.delete(k); // keep the map small
    const recent = (runLog.get(ip) ?? []).filter((t) => t > cutoff);
    if (recent.length >= perHour) {
      runLog.set(ip, recent);
      return true;
    }
    recent.push(Date.now());
    runLog.set(ip, recent);
    return false;
  }

  app.post('/api/agent/run', owner, async (req, res) => {
    if (typeof req.body?.task !== 'string') throw new HttpError(400, 'Tell the agent what to buy.');
    const task = req.body.task.trim();
    if (!task) throw new HttpError(400, 'Tell the agent what to buy.');
    if (task.length > 300) throw new HttpError(400, 'Keep the job under 300 characters.');
    if (overLimit(req.ip)) {
      throw new HttpError(429, `This demo allows ${perHour} agent runs per hour. Try again later.`);
    }
    if (activeRuns >= 3) throw new HttpError(429, 'The agent is busy with other runs. Try again in a moment.');
    activeRuns++;
    res.on('close', () => {
      activeRuns--;
    });

    res.set({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const emit = (event) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    };

    try {
      await agent.run(task, emit, controller.signal);
      emit({ type: 'done' });
    } catch (err) {
      emit({ type: 'error', message: friendlyAgentError(err) });
    }
    res.end();
  });

  // --- the owner's decisions --------------------------------------------
  app.post('/api/purchases/:id/approve', owner, async (req, res) => res.json(await wallet.approvePurchase(req.params.id)));
  app.post('/api/purchases/:id/decline', owner, async (req, res) => res.json(await wallet.declinePurchase(req.params.id)));

  app.post('/api/reset', owner, async (req, res) => {
    if (env.ALLOW_RESET !== '1') throw new HttpError(404, 'Not found');
    await wallet.reset();
    res.json(snapshot());
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // body-parser errors carry a status too; keep their wording generic.
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'That request was not valid JSON.');
    if (err.type === 'entity.too.large') err = new HttpError(413, 'That request is too large.');
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status === 500 ? 'Something went wrong on our side.' : err.message });
  });

  return { app, wallet, agent, paypal };
}

// Start listening only when run directly (`node server.js`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: fine, defaults and real environment variables apply.
  }
  const { app, agent, paypal } = createApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`AgentWallet listening on http://localhost:${port}`);
    console.log(`  PayPal: ${paypal.mode}${paypal.mode === 'mock' ? ' (no money moves)' : ' (sandbox)'}`);
    console.log(`  Agent:  ${agent.mode === 'claude' ? `Claude (${agent.model})` : 'demo keyword agent (set ANTHROPIC_API_KEY for Claude)'}`);
  });
}
