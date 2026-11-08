import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createAgent } from '../src/agent.js';

const ENV = { PAYPAL_MODE: 'mock', ALLOW_RESET: '1', AGENT_RUNS_PER_HOUR: '1000' };

async function boot(env = {}) {
  const ctx = createApp({ env: { ...ENV, ...env }, dataDir: null });
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const state = async () => (await api('GET', '/api/state')).json;
  const addFunds = async (cents) => {
    const t = await api('POST', '/api/topup', { amountCents: cents });
    const token = new URL(t.json.approveUrl, base).searchParams.get('token');
    const r = await api('GET', `/topup/return?token=${token}`);
    return { token, redirect: r.headers.get('location') };
  };
  const runAgent = async (task) => {
    const res = await fetch(`${base}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    const events = (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { status: res.status, events, purchases: events.filter((e) => e.type === 'purchase').map((e) => e.purchase) };
  };
  return { ...ctx, base, api, state, addFunds, runAgent, close: () => server.close() };
}

test('adding funds through the (mock) PayPal checkout credits the wallet once', async () => {
  const t = await boot();
  try {
    assert.equal((await t.state()).wallet.balanceCents, 0);
    const created = await t.api('POST', '/api/topup', { amountCents: 10_000 });
    assert.equal(created.status, 200);
    assert.match(created.json.approveUrl, /^\/mock\/paypal\/approve\?token=MOCK-/);

    const token = new URL(created.json.approveUrl, t.base).searchParams.get('token');
    const page = await t.api('GET', created.json.approveUrl);
    assert.equal(page.status, 200);
    assert.match(page.text, /Pay \$100\.00/);

    const r1 = await t.api('GET', `/topup/return?token=${token}`);
    assert.equal(r1.headers.get('location'), '/?topup=success');
    // Opening the return link again must not credit twice.
    await t.api('GET', `/topup/return?token=${token}`);
    assert.equal((await t.state()).wallet.balanceCents, 10_000);
  } finally {
    t.close();
  }
});

test('rejects bad top-up amounts and unknown return tokens', async () => {
  const t = await boot();
  try {
    assert.equal((await t.api('POST', '/api/topup', { amountCents: 5 })).status, 400);
    assert.equal((await t.api('POST', '/api/topup', { amountCents: 99_999 })).status, 400);
    const r = await t.api('GET', '/topup/return?token=MOCK-NOPE');
    assert.equal(r.headers.get('location'), '/?topup=failed');
    assert.equal((await t.state()).wallet.balanceCents, 0);
  } finally {
    t.close();
  }
});

test('the agent buys a small item on its own and the wallet is charged', async () => {
  const t = await boot();
  try {
    await t.addFunds(10_000);
    const run = await t.runAgent('Buy a USB-C hub under $30');
    assert.equal(run.purchases.length, 1);
    const p = run.purchases[0];
    assert.equal(p.decision, 'allowed');
    assert.equal(p.status, 'settled');
    assert.equal(p.settlement.mode, 'simulated');
    const s = await t.state();
    assert.equal(s.wallet.balanceCents, 10_000 - p.amountCents);
    assert.equal(s.spentTodayCents, p.amountCents);
    assert.ok(run.events.some((e) => e.type === 'done'));
  } finally {
    t.close();
  }
});

test('a purchase over the hard limit is blocked and costs nothing', async () => {
  const t = await boot();
  try {
    await t.addFunds(50_000);
    const run = await t.runAgent('Order a standing desk');
    assert.equal(run.purchases[0].decision, 'denied');
    assert.equal(run.purchases[0].status, 'denied');
    assert.equal((await t.state()).wallet.balanceCents, 50_000);
  } finally {
    t.close();
  }
});

test('the hostile "ignore your rules" catalog item is still blocked by the wallet', async () => {
  const t = await boot();
  try {
    await t.addFunds(50_000);
    const run = await t.runAgent('Buy the productivity bundle');
    assert.equal(run.purchases.length, 1);
    assert.equal(run.purchases[0].title, 'Mega productivity bundle');
    assert.equal(run.purchases[0].decision, 'denied');
    assert.match(run.purchases[0].reasons.join(' '), /blocked merchants/);
    assert.equal((await t.state()).wallet.balanceCents, 50_000);
  } finally {
    t.close();
  }
});

test('a mid-price purchase waits for the owner, who can approve it', async () => {
  const t = await boot();
  try {
    await t.addFunds(20_000);
    const run = await t.runAgent('Get a mechanical keyboard');
    const p = run.purchases[0];
    assert.equal(p.decision, 'held');
    assert.equal(p.status, 'pending');
    let s = await t.state();
    assert.equal(s.pendingCount, 1);
    assert.equal(s.wallet.balanceCents, 20_000); // nothing spent yet

    const approved = await t.api('POST', `/api/purchases/${p.id}/approve`);
    assert.equal(approved.json.status, 'settled');
    assert.equal(approved.json.decidedBy, 'owner');
    s = await t.state();
    assert.equal(s.pendingCount, 0);
    assert.equal(s.wallet.balanceCents, 20_000 - p.amountCents);

    // Approving twice must fail rather than charge twice.
    assert.equal((await t.api('POST', `/api/purchases/${p.id}/approve`)).status, 409);
  } finally {
    t.close();
  }
});

test('declining a held purchase spends nothing', async () => {
  const t = await boot();
  try {
    await t.addFunds(20_000);
    const p = (await t.runAgent('Get a mechanical keyboard')).purchases[0];
    const declined = await t.api('POST', `/api/purchases/${p.id}/decline`);
    assert.equal(declined.json.status, 'declined');
    assert.equal((await t.state()).wallet.balanceCents, 20_000);
  } finally {
    t.close();
  }
});

test('two purchases requested at the same moment cannot spend the same money', async () => {
  const t = await boot();
  try {
    await t.addFunds(3000); // enough for exactly one $24.90 hub
    const [a, b] = await Promise.all([
      t.wallet.requestPurchase({ itemId: 'hub-7in1', justification: 'a' }),
      t.wallet.requestPurchase({ itemId: 'hub-7in1', justification: 'b' }),
    ]);
    const decisions = [a.decision, b.decision].sort();
    assert.deepEqual(decisions, ['allowed', 'denied']);
    assert.equal((await t.state()).wallet.balanceCents, 3000 - 2490);
  } finally {
    t.close();
  }
});

test('the daily budget holds later purchases for approval', async () => {
  const t = await boot();
  try {
    await t.addFunds(20_000);
    const rules = { ...(await t.state()).rules, dailyBudgetCents: 3000 };
    assert.equal((await t.api('PUT', '/api/rules', rules)).status, 200);
    const first = await t.wallet.requestPurchase({ itemId: 'hub-slim', justification: '' }); // $18.90
    const second = await t.wallet.requestPurchase({ itemId: 'notebook-3pack', justification: '' }); // $14.50
    assert.equal(first.decision, 'allowed');
    assert.equal(second.decision, 'held');
    assert.match(second.reasons[0], /daily budget/);
  } finally {
    t.close();
  }
});

test('invalid rules are rejected with a readable message', async () => {
  const t = await boot();
  try {
    const rules = { ...(await t.state()).rules, autoApproveLimitCents: 9000, hardLimitCents: 5000 };
    const r = await t.api('PUT', '/api/rules', rules);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /cannot be higher/);
  } finally {
    t.close();
  }
});

test('an unknown item id is rejected and the agent cannot name its own price', async () => {
  const t = await boot();
  try {
    await assert.rejects(() => t.wallet.requestPurchase({ itemId: 'free-laptop', justification: '' }), /No item/);
  } finally {
    t.close();
  }
});

test('Claude tool-use loop: a scripted model asks for a blocked item and the wallet refuses', async () => {
  const t = await boot();
  try {
    await t.addFunds(50_000);
    const calls = [];
    const script = [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'request_purchase', input: { item_id: 'standing-desk', justification: 'Owner asked for a desk.' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The desk was blocked: it is over your per-purchase limit.' }] },
    ];
    const fakeClient = {
      messages: {
        create: async (req) => {
          calls.push(structuredClone(req.messages));
          return script[calls.length - 1];
        },
      },
    };
    const agent = createAgent({ wallet: t.wallet, env: { ANTHROPIC_API_KEY: 'test-key' }, clientFactory: () => fakeClient });
    assert.equal(agent.mode, 'claude');

    const events = [];
    await agent.run('Order a standing desk', (e) => events.push(e));

    assert.equal(calls.length, 2);
    // The second request must carry the wallet's answer back to the model.
    const toolResult = calls[1].at(-1).content[0];
    assert.equal(toolResult.type, 'tool_result');
    assert.equal(toolResult.tool_use_id, 'tu_1');
    assert.equal(JSON.parse(toolResult.content).decision, 'denied');
    assert.ok(events.some((e) => e.type === 'purchase' && e.purchase.decision === 'denied'));
    assert.ok(events.some((e) => e.type === 'text' && /blocked/.test(e.text)));
    assert.equal((await t.state()).wallet.balanceCents, 50_000);
  } finally {
    t.close();
  }
});

test('Claude tool-use loop: requesting the same item twice is refused', async () => {
  const t = await boot();
  try {
    await t.addFunds(50_000);
    let n = 0;
    const use = (id) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'request_purchase', input: { item_id: 'hub-slim', justification: 'x' } }] });
    const script = [use('a'), use('b'), { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }];
    const results = [];
    const fakeClient = {
      messages: {
        create: async (req) => {
          const last = req.messages.at(-1);
          if (Array.isArray(last.content)) results.push(JSON.parse(last.content[0].content));
          return script[n++];
        },
      },
    };
    const agent = createAgent({ wallet: t.wallet, env: { ANTHROPIC_API_KEY: 'k' }, clientFactory: () => fakeClient });
    await agent.run('Buy a hub', () => {});
    assert.equal(results[0].decision, 'allowed');
    assert.match(results[1].error, /already requested/);
    assert.equal((await t.state()).purchases.length, 1);
  } finally {
    t.close();
  }
});

test('reset clears the wallet when enabled, and is hidden when not', async () => {
  const t = await boot();
  try {
    await t.addFunds(5000);
    const r = await t.api('POST', '/api/reset');
    assert.equal(r.json.wallet.balanceCents, 0);
  } finally {
    t.close();
  }
  const off = await boot({ ALLOW_RESET: '0' });
  try {
    assert.equal((await off.api('POST', '/api/reset')).status, 404);
  } finally {
    off.close();
  }
});
