import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { createStore } from '../src/store.js';
import { createWalletService } from '../src/wallet.js';
import { DEFAULT_RULES } from '../src/policy.js';
import { createAgent } from '../src/agent.js';

// A PayPal stand-in whose behaviour each test can script.
function fakePayPal(over = {}) {
  return {
    mode: 'mock',
    receiverConfigured: true,
    createOrder: async () => ({ id: 'ORDER1', approveUrl: '/x' }),
    captureOrder: async (id, cents) => ({ status: 'COMPLETED', captureId: 'CAP1', amountCents: cents }),
    settle: async () => ({ mode: 'sandbox', status: 'PENDING' }),
    ...over,
  };
}
const boot = (paypal) => {
  const store = createStore(null);
  return { store, wallet: createWalletService({ store, paypal }) };
};
const topUp = async (wallet, cents) => {
  await wallet.startTopup(cents, { returnUrl: 'r', cancelUrl: 'c' });
  return wallet.completeTopup('ORDER1');
};

test('owner routes need the owner key when one is set', async () => {
  const { app } = createApp({ env: { PAYPAL_MODE: 'mock', OWNER_KEY: 'sesame', ALLOW_RESET: '1' }, dataDir: null });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method, key, body) =>
    fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'x-owner-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await call('/api/state', 'GET')).status, 200, 'reading is public');
    for (const [p, m, b] of [
      ['/api/rules', 'PUT', DEFAULT_RULES],
      ['/api/topup', 'POST', { amountCents: 5000 }],
      ['/api/agent/run', 'POST', { task: 'buy a notebook' }],
      ['/api/purchases/p_x/approve', 'POST'],
      ['/api/purchases/p_x/decline', 'POST'],
      ['/api/reset', 'POST'],
    ]) {
      assert.equal((await call(p, m, null, b)).status, 401, `${m} ${p} without a key`);
      assert.equal((await call(p, m, 'wrong', b)).status, 401, `${m} ${p} with a wrong key`);
    }
    assert.equal((await call('/api/topup', 'POST', 'sesame', { amountCents: 5000 })).status, 200);
  } finally {
    server.close();
  }
});

test('real PayPal credentials without an owner key refuse to start', () => {
  assert.throws(
    () => createApp({ env: { PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b', PUBLIC_URL: 'http://x' }, dataDir: null }),
    /OWNER_KEY/,
  );
});

test('cross-site POSTs are refused', async () => {
  const { app } = createApp({ env: { PAYPAL_MODE: 'mock', ALLOW_RESET: '1' }, dataDir: null });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/reset`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('approving a held purchase fails if the rules now forbid it', async () => {
  const { wallet } = boot(fakePayPal());
  await topUp(wallet, 20_000);
  const held = await wallet.requestPurchase({ itemId: 'earbuds' });
  assert.equal(held.decision, 'held');
  wallet.updateRules({ ...DEFAULT_RULES, allowedCategories: ['books'] });
  const after = await wallet.approvePurchase(held.id);
  assert.equal(after.status, 'denied');
  assert.equal(wallet.getState().wallet.balanceCents, 20_000, 'nothing was spent');
});

test('a capture that times out can be retried and credits the wallet exactly once', async () => {
  let calls = 0;
  const { wallet } = boot(
    fakePayPal({
      captureOrder: async (id, cents) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        return { status: 'COMPLETED', captureId: 'CAP1', amountCents: cents };
      },
    }),
  );
  await wallet.startTopup(5_000, { returnUrl: 'r', cancelUrl: 'c' });
  await assert.rejects(wallet.completeTopup('ORDER1'), /did not confirm/);
  assert.equal(wallet.getState().topups[0].status, 'pending');
  await wallet.completeTopup('ORDER1');
  await wallet.completeTopup('ORDER1'); // opening the return link again changes nothing
  assert.equal(wallet.getState().wallet.balanceCents, 5_000);
});

test('a definitive PayPal refusal during capture marks the top-up failed', async () => {
  const { wallet } = boot(
    fakePayPal({
      captureOrder: async () => {
        throw Object.assign(new Error('declined'), { status: 422 });
      },
    }),
  );
  await wallet.startTopup(5_000, { returnUrl: 'r', cancelUrl: 'c' });
  const t = await wallet.completeTopup('ORDER1');
  assert.equal(t.status, 'failed');
  assert.equal(wallet.getState().wallet.balanceCents, 0);
});

test('a payout that times out keeps the funds reserved instead of paying twice', async () => {
  const { wallet } = boot(
    fakePayPal({
      settle: async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      },
    }),
  );
  await topUp(wallet, 20_000);
  const p = await wallet.requestPurchase({ itemId: 'notebook-3pack' });
  assert.equal(p.status, 'unconfirmed');
  const s = wallet.getState();
  assert.equal(s.wallet.balanceCents, 20_000 - p.amountCents, 'funds stay reserved');
  assert.equal(s.spentTodayCents, p.amountCents, 'and count toward the daily budget');
});

test('a definitive payout failure gives the money back', async () => {
  const { wallet } = boot(
    fakePayPal({
      settle: async () => {
        throw Object.assign(new Error('receiver unregistered'), { status: 400 });
      },
    }),
  );
  await topUp(wallet, 20_000);
  const p = await wallet.requestPurchase({ itemId: 'notebook-3pack' });
  assert.equal(p.status, 'failed');
  assert.equal(wallet.getState().wallet.balanceCents, 20_000);
});

test('a crash mid-payout is recovered on restart with the funds still reserved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'));
  const first = createStore(dir);
  first.state.wallet.balanceCents = 1_000;
  first.state.purchases.push({ id: 'p_1', ts: new Date().toISOString(), status: 'settling', amountCents: 500 });
  first.save();
  const second = createStore(dir);
  assert.equal(second.state.purchases[0].status, 'unconfirmed');
  assert.match(second.state.purchases[0].error, /restarted/);
  assert.equal(second.state.wallet.balanceCents, 1_000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a partial or malformed data file does not crash the wallet', async () => {
  for (const content of ['{"rules":{}}', '{"purchases":"nope"}', '[]', 'null', '{"wallet":{"balanceCents":-5}}']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'));
    fs.writeFileSync(path.join(dir, 'db.json'), content);
    const store = createStore(dir);
    const wallet = createWalletService({ store, paypal: fakePayPal() });
    const s = wallet.getState();
    assert.ok(Array.isArray(s.purchases) && s.wallet.balanceCents >= 0, content);
    assert.ok(s.rules.hardLimitCents > 0, content);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bounded history keeps the data file from growing forever', async () => {
  const { wallet, store } = boot(fakePayPal());
  await topUp(wallet, 50_000);
  wallet.updateRules({ ...DEFAULT_RULES, dailyBudgetCents: 50_000 });
  for (let i = 0; i < 520; i++) store.state.purchases.push({ id: `p_${i}`, ts: new Date().toISOString(), status: 'declined' });
  await wallet.requestPurchase({ itemId: 'notebook-3pack' });
  assert.ok(store.state.purchases.length <= 500);
});

test('a spoofed X-Forwarded-For cannot dodge the agent-run limit', async () => {
  const { app } = createApp({ env: { PAYPAL_MODE: 'mock', AGENT_RUNS_PER_HOUR: '2' }, dataDir: null });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const run = (i) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${i}` },
      body: JSON.stringify({ task: 'buy a gel pen' }),
    }).then((r) => r.status);
  try {
    const codes = [];
    for (let i = 1; i <= 4; i++) codes.push(await run(i));
    assert.deepEqual(codes, [200, 200, 429, 429]);
  } finally {
    server.close();
  }
});

test('the agent job must be text', async () => {
  const { app } = createApp({ env: { PAYPAL_MODE: 'mock' }, dataDir: null });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  try {
    for (const task of [{ a: 1 }, ['x'], 42, null]) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
      });
      assert.equal(res.status, 400, JSON.stringify(task));
    }
  } finally {
    server.close();
  }
});

test('a visitor-supplied Claude key is used for that run only and never echoed or stored', async () => {
  const SECRET = 'sk-ant-api03-TESTKEYTESTKEYTESTKEY1234';
  const seen = [];
  const fakeClient = { messages: { create: async () => ({ content: [{ type: 'text', text: 'Nothing to buy.' }], stop_reason: 'end_turn' }) } };
  const { wallet, store } = boot(fakePayPal());
  // No key on the server at all: the agent starts in demo mode.
  const agent = createAgent({ wallet, env: {}, clientFactory: (key) => (seen.push(key), fakeClient) });
  assert.equal(agent.mode, 'demo');

  const events = [];
  await agent.run('buy a pen', (e) => events.push(e), undefined, { apiKey: SECRET });
  assert.deepEqual(seen, [SECRET], 'the visitor key reached the client for this run');
  assert.ok(!JSON.stringify(events).includes(SECRET), 'never echoed in events');
  assert.ok(!JSON.stringify(store.state).includes(SECRET), 'never stored in wallet state');

  await agent.run('buy a pen', () => {});
  assert.equal(seen.length, 1, 'the next run without a key falls back to the demo agent');
});

test('AI_MODE=demo refuses visitor keys, and malformed keys are rejected without being echoed', async () => {
  const { app } = createApp({ env: { PAYPAL_MODE: 'mock' }, dataDir: null });
  const { app: demoApp } = createApp({ env: { PAYPAL_MODE: 'mock', AI_MODE: 'demo' }, dataDir: null });
  const open = (a) => new Promise((r) => { const s = a.listen(0, () => r(s)); });
  const [s1, s2] = [await open(app), await open(demoApp)];
  const post = (s, key) =>
    fetch(`http://127.0.0.1:${s.address().port}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-anthropic-key': key },
      body: JSON.stringify({ task: 'buy a pen' }),
    });
  try {
    const bad = await post(s1, 'short key with spaces!');
    assert.equal(bad.status, 400);
    assert.ok(!(await bad.text()).includes('short key'), 'bad key not echoed');
    assert.equal((await post(s2, 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV')).status, 400, 'demo-only server refuses keys');
  } finally {
    s1.close();
    s2.close();
  }
});
