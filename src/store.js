import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RULES, validateRules } from './policy.js';

function freshState() {
  return {
    wallet: { balanceCents: 0, currency: 'USD' },
    rules: structuredClone(DEFAULT_RULES),
    purchases: [],
    topups: [],
  };
}

// Accept only a well-formed file; anything else falls back to safe defaults.
function normalise(parsed) {
  const base = freshState();
  if (!parsed || typeof parsed !== 'object') return base;
  const v = validateRules(parsed.rules);
  const balance = parsed.wallet?.balanceCents;
  const purchases = Array.isArray(parsed.purchases) ? parsed.purchases.filter((p) => p && typeof p.id === 'string' && typeof p.ts === 'string') : [];
  for (const p of purchases) {
    // A crash mid-payout: we cannot know the outcome, so keep the funds reserved and say so.
    if (p.status === 'settling') {
      p.status = 'unconfirmed';
      p.error = `The server restarted during this payout (batch aw-${p.id}). The funds stay reserved. Check your sandbox activity.`;
    }
  }
  return {
    wallet: { balanceCents: Number.isInteger(balance) && balance >= 0 ? balance : 0, currency: 'USD' },
    rules: v.ok ? v.rules : base.rules,
    purchases,
    topups: Array.isArray(parsed.topups) ? parsed.topups.filter((t) => t && typeof t.orderId === 'string') : [],
  };
}

/**
 * A tiny JSON-file store. The whole state is small, so every change rewrites
 * the file atomically (write to a temp file, then rename). Pass dir = null to
 * keep everything in memory, which the tests do.
 */
export function createStore(dir) {
  const file = dir ? path.join(dir, 'db.json') : null;
  let state = freshState();

  if (file) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {
      try {
        state = normalise(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        // A corrupt file should not stop the app from starting.
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      }
    }
  }

  function save() {
    if (!file) return;
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  return {
    get state() {
      return state;
    },
    save,
    reset() {
      state = freshState();
      save();
    },
  };
}
