// The policy engine is plain, deterministic code. The AI agent never decides
// whether a purchase is allowed; it can only ask, and this module answers.
// That is what keeps a confused or manipulated agent from overspending.

export const CATEGORIES = ['office', 'electronics', 'books', 'home', 'gift-cards', 'luxury'];

export const DEFAULT_RULES = {
  autoApproveLimitCents: 2500, // the agent may spend up to this on its own
  hardLimitCents: 7500, // above this a purchase is blocked outright
  dailyBudgetCents: 10000, // total the agent may spend per day without asking
  allowedCategories: ['office', 'electronics', 'books', 'home'],
  blockedMerchants: ['FlashDeal Outlet'],
};

export function fmt(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function isCents(n, max) {
  return Number.isInteger(n) && n >= 0 && n <= max;
}

/** Validates owner-supplied rules. Returns { ok, rules, errors }. */
export function validateRules(input) {
  const errors = [];
  const r = input ?? {};

  if (!isCents(r.autoApproveLimitCents, 100_000)) errors.push('Auto-approve limit must be between $0 and $1,000.');
  if (!isCents(r.hardLimitCents, 100_000)) errors.push('Per-purchase limit must be between $0 and $1,000.');
  if (!isCents(r.dailyBudgetCents, 500_000)) errors.push('Daily budget must be between $0 and $5,000.');
  if (
    isCents(r.autoApproveLimitCents, 100_000) &&
    isCents(r.hardLimitCents, 100_000) &&
    r.autoApproveLimitCents > r.hardLimitCents
  ) {
    errors.push('The auto-approve limit cannot be higher than the per-purchase limit.');
  }

  const cats = Array.isArray(r.allowedCategories) ? r.allowedCategories : null;
  if (!cats || cats.some((c) => !CATEGORIES.includes(c))) errors.push('Choose categories from the list.');

  let blocked = Array.isArray(r.blockedMerchants) ? r.blockedMerchants : null;
  if (!blocked) {
    errors.push('Blocked merchants must be a list.');
  } else {
    blocked = blocked.map((m) => String(m).trim()).filter(Boolean);
    if (blocked.length > 20 || blocked.some((m) => m.length > 60)) {
      errors.push('Block up to 20 merchants, with names under 60 characters.');
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    rules: {
      autoApproveLimitCents: r.autoApproveLimitCents,
      hardLimitCents: r.hardLimitCents,
      dailyBudgetCents: r.dailyBudgetCents,
      allowedCategories: [...new Set(cats)],
      blockedMerchants: [...new Set(blocked)],
    },
  };
}

/**
 * Decides what happens to one purchase request.
 *   ctx: { amountCents, category, merchant, balanceCents, spentTodayCents }
 *   returns { decision: 'allowed' | 'held' | 'denied', reasons: string[] }
 * "held" means a person has to approve it first.
 */
export function evaluate(rules, ctx) {
  const deny = [];
  const hold = [];

  const blocked = rules.blockedMerchants.map((m) => m.toLowerCase());
  if (blocked.includes(String(ctx.merchant).toLowerCase())) {
    deny.push(`${ctx.merchant} is on your blocked merchants list.`);
  }

  if (!rules.allowedCategories.includes(ctx.category)) {
    deny.push(`The "${ctx.category}" category is not on your allowed list.`);
  }

  if (ctx.amountCents > rules.hardLimitCents) {
    deny.push(`${fmt(ctx.amountCents)} is over your ${fmt(rules.hardLimitCents)} per-purchase limit.`);
  }

  if (ctx.amountCents > ctx.balanceCents) {
    deny.push(`The wallet has ${fmt(ctx.balanceCents)} and this costs ${fmt(ctx.amountCents)}.`);
  }

  if (ctx.spentTodayCents + ctx.amountCents > rules.dailyBudgetCents) {
    hold.push(
      `It would bring today's spending to ${fmt(ctx.spentTodayCents + ctx.amountCents)}, past your ${fmt(rules.dailyBudgetCents)} daily budget.`,
    );
  }

  if (ctx.amountCents > rules.autoApproveLimitCents) {
    hold.push(`${fmt(ctx.amountCents)} is above the ${fmt(rules.autoApproveLimitCents)} the agent can spend on its own.`);
  }

  if (deny.length) return { decision: 'denied', reasons: deny };
  if (hold.length) return { decision: 'held', reasons: hold };
  return { decision: 'allowed', reasons: ['Within all of your rules.'] };
}

/** One plain-language sentence describing the rules, shown above the rules form. */
export function describeRules(rules) {
  return (
    `The agent can spend up to ${fmt(rules.autoApproveLimitCents)} on its own. ` +
    `From ${fmt(rules.autoApproveLimitCents + 1)} to ${fmt(rules.hardLimitCents)} it asks you first. ` +
    `Anything above ${fmt(rules.hardLimitCents)} is blocked. ` +
    `Past ${fmt(rules.dailyBudgetCents)} in a day it asks you for everything.`
  );
}
