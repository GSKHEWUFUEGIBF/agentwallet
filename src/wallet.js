import crypto from 'node:crypto';
import { describeRules, evaluate, validateRules } from './policy.js';
import { getItem } from './catalog.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SPENT = new Set(['settled', 'settling', 'unconfirmed']);
// Errors where PayPal may or may not have processed the request.
const outcomeUnknown = (err) =>
  err?.name === 'TimeoutError' || err?.name === 'AbortError' || err instanceof TypeError || err?.status >= 500;
const MAX_PURCHASES = 500;
const MAX_TOPUPS = 200;

const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

/**
 * Everything that touches money goes through here, one operation at a time,
 * so two requests arriving together can never spend the same funds twice.
 */
export function createWalletService({ store, paypal, now = () => new Date() }) {
  let chain = Promise.resolve();
  const locked = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  function spentTodayCents() {
    const today = now().toISOString().slice(0, 10);
    return store.state.purchases
      .filter((p) => SPENT.has(p.status) && p.ts.slice(0, 10) === today)
      .reduce((sum, p) => sum + p.amountCents, 0);
  }

  // Funds are reserved and the intent is saved BEFORE PayPal is called, so a crash
  // or timeout can never leave money paid out with nothing recorded.
  async function settle(p) {
    const s = store.state;
    s.wallet.balanceCents -= p.amountCents;
    p.status = 'settling';
    store.save();
    try {
      p.settlement = await paypal.settle({
        purchaseId: p.id,
        merchant: p.merchant,
        amountCents: p.amountCents,
        title: p.title,
      });
      p.status = 'settled';
    } catch (err) {
      if (outcomeUnknown(err)) {
        // PayPal may have processed it. Keep the funds reserved rather than risk paying twice.
        p.status = 'unconfirmed';
        p.error = `PayPal did not confirm this payout (batch aw-${p.id}). The funds stay reserved. Check your sandbox activity before retrying.`;
      } else {
        s.wallet.balanceCents += p.amountCents;
        p.status = 'failed';
        p.error = err.message;
      }
    }
  }

  return {
    getState() {
      const s = store.state;
      const spent = spentTodayCents();
      return {
        modes: { paypal: paypal.mode, receiverConfigured: paypal.receiverConfigured ?? false },
        wallet: s.wallet,
        rules: s.rules,
        rulesSummary: describeRules(s.rules),
        spentTodayCents: spent,
        remainingTodayCents: Math.max(0, s.rules.dailyBudgetCents - spent),
        pendingCount: s.purchases.filter((p) => p.decision === 'held' && p.status === 'pending').length,
        purchases: s.purchases.slice(0, 40),
        topups: s.topups.slice(0, 10),
      };
    },

    walletSnapshotForAgent() {
      const s = store.state;
      const spent = spentTodayCents();
      return {
        balance_usd: s.wallet.balanceCents / 100,
        spent_today_usd: spent / 100,
        remaining_daily_budget_usd: Math.max(0, s.rules.dailyBudgetCents - spent) / 100,
        auto_approve_up_to_usd: s.rules.autoApproveLimitCents / 100,
        blocked_above_usd: s.rules.hardLimitCents / 100,
        allowed_categories: s.rules.allowedCategories,
        blocked_merchants: s.rules.blockedMerchants,
      };
    },

    updateRules(input) {
      const result = validateRules(input);
      if (!result.ok) throw new HttpError(400, result.errors.join(' '));
      store.state.rules = result.rules;
      store.save();
      return store.state.rules;
    },

    async startTopup(amountCents, { returnUrl, cancelUrl }) {
      if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 50_000) {
        throw new HttpError(400, 'Add between $1 and $500 at a time.');
      }
      const topup = { id: newId('t'), ts: now().toISOString(), amountCents, status: 'pending', mode: paypal.mode };
      const order = await paypal.createOrder({ amountCents, referenceId: topup.id, returnUrl, cancelUrl });
      topup.orderId = order.id;
      store.state.topups.unshift(topup);
      store.state.topups.length = Math.min(store.state.topups.length, MAX_TOPUPS);
      store.save();
      return { topup, approveUrl: order.approveUrl };
    },

    completeTopup(orderId) {
      return locked(async () => {
        const topup = store.state.topups.find((t) => t.orderId === orderId);
        if (!topup) throw new HttpError(404, 'We have no pending payment with that reference.');
        if (topup.status === 'completed') return topup; // safe to open the return link twice
        if (topup.status !== 'pending') throw new HttpError(409, `This payment was ${topup.status}.`);
        try {
          const cap = await paypal.captureOrder(orderId, topup.amountCents);
          if (cap.status !== 'COMPLETED' || cap.amountCents !== topup.amountCents) {
            topup.status = 'failed';
            topup.error = `PayPal reported ${cap.status} for ${cap.amountCents} cents; expected ${topup.amountCents}.`;
          } else {
            topup.status = 'completed';
            topup.captureId = cap.captureId;
            store.state.wallet.balanceCents += topup.amountCents;
          }
        } catch (err) {
          if (outcomeUnknown(err)) {
            // PayPal's answer is unknown. Capture is idempotent, so the return link can be opened again.
            throw new HttpError(502, 'PayPal did not confirm the payment yet. Open the return link again in a moment.');
          }
          topup.status = 'failed';
          topup.error = err.message;
        }
        store.save();
        return topup;
      });
    },

    cancelTopup(orderId) {
      return locked(async () => {
        const topup = store.state.topups.find((t) => t.orderId === orderId);
        if (topup && topup.status === 'pending') {
          topup.status = 'cancelled';
          store.save();
        }
        return topup ?? null;
      });
    },

    /** An agent (or the owner) asks to buy a catalog item. The price always comes from the catalog. */
    requestPurchase({ itemId, justification, source = 'agent' }) {
      return locked(async () => {
        const item = getItem(itemId);
        if (!item) throw new HttpError(404, `No item with id "${itemId}".`);
        const s = store.state;
        const { decision, reasons } = evaluate(s.rules, {
          amountCents: item.priceCents,
          category: item.category,
          merchant: item.merchant,
          balanceCents: s.wallet.balanceCents,
          spentTodayCents: spentTodayCents(),
        });
        const p = {
          id: newId('p'),
          ts: now().toISOString(),
          itemId: item.id,
          title: item.title,
          merchant: item.merchant,
          category: item.category,
          amountCents: item.priceCents,
          justification: String(justification ?? '').slice(0, 300),
          source,
          decision,
          reasons,
          status: decision === 'denied' ? 'denied' : 'pending',
          decidedBy: 'rules',
        };
        s.purchases.unshift(p);
        s.purchases.length = Math.min(s.purchases.length, MAX_PURCHASES);
        if (decision === 'allowed') await settle(p);
        store.save();
        return p;
      });
    },

    approvePurchase(id) {
      return locked(async () => {
        const p = store.state.purchases.find((x) => x.id === id);
        if (!p) throw new HttpError(404, 'No such purchase.');
        if (p.decision !== 'held' || p.status !== 'pending') {
          throw new HttpError(409, 'This purchase is not waiting for approval.');
        }
        p.decidedBy = 'owner';
        p.decidedAt = now().toISOString();
        const recheck = evaluate(store.state.rules, {
          amountCents: p.amountCents,
          category: p.category,
          merchant: p.merchant,
          balanceCents: store.state.wallet.balanceCents,
          spentTodayCents: spentTodayCents(),
        });
        if (p.amountCents > store.state.wallet.balanceCents) {
          p.status = 'failed';
          p.error = 'The wallet no longer has enough funds. Add funds and ask the agent again.';
        } else if (recheck.decision === 'denied') {
          // Rules changed since this was held. Approval never overrides a hard block.
          p.status = 'denied';
          p.decision = 'denied';
          p.reasons = recheck.reasons;
        } else {
          await settle(p);
        }
        store.save();
        return p;
      });
    },

    declinePurchase(id) {
      return locked(async () => {
        const p = store.state.purchases.find((x) => x.id === id);
        if (!p) throw new HttpError(404, 'No such purchase.');
        if (p.decision !== 'held' || p.status !== 'pending') {
          throw new HttpError(409, 'This purchase is not waiting for approval.');
        }
        p.status = 'declined';
        p.decidedBy = 'owner';
        p.decidedAt = now().toISOString();
        store.save();
        return p;
      });
    },

    reset() {
      return locked(async () => store.reset());
    },
  };
}
