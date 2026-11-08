import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, evaluate, validateRules } from '../src/policy.js';

const base = { amountCents: 1000, category: 'office', merchant: 'Paperkind', balanceCents: 50_000, spentTodayCents: 0 };
const run = (over = {}, rules = DEFAULT_RULES) => evaluate(rules, { ...base, ...over });

test('allows a small purchase that fits every rule', () => {
  assert.equal(run().decision, 'allowed');
});

test('allows a purchase exactly at the auto-approve limit', () => {
  assert.equal(run({ amountCents: DEFAULT_RULES.autoApproveLimitCents }).decision, 'allowed');
});

test('holds a purchase just above the auto-approve limit', () => {
  const r = run({ amountCents: DEFAULT_RULES.autoApproveLimitCents + 1 });
  assert.equal(r.decision, 'held');
  assert.match(r.reasons[0], /above the \$25\.00/);
});

test('allows exactly the per-purchase limit to be held, not denied', () => {
  assert.equal(run({ amountCents: DEFAULT_RULES.hardLimitCents }).decision, 'held');
});

test('denies a purchase above the per-purchase limit', () => {
  const r = run({ amountCents: DEFAULT_RULES.hardLimitCents + 1 });
  assert.equal(r.decision, 'denied');
  assert.match(r.reasons.join(' '), /per-purchase limit/);
});

test('denies a blocked merchant regardless of case', () => {
  assert.equal(run({ merchant: 'flashdeal outlet' }).decision, 'denied');
});

test('denies a category that is not allowed', () => {
  const r = run({ category: 'luxury' });
  assert.equal(r.decision, 'denied');
  assert.match(r.reasons[0], /luxury/);
});

test('denies when the wallet cannot cover the price', () => {
  const r = run({ balanceCents: 500 });
  assert.equal(r.decision, 'denied');
  assert.match(r.reasons[0], /wallet has \$5\.00/);
});

test('holds when a purchase would pass the daily budget', () => {
  const r = run({ amountCents: 2000, spentTodayCents: 9000 });
  assert.equal(r.decision, 'held');
  assert.match(r.reasons[0], /daily budget/);
});

test('a denial wins over a hold', () => {
  const r = run({ amountCents: 9000, spentTodayCents: 9000 });
  assert.equal(r.decision, 'denied');
});

test('reports every reason that applies', () => {
  const r = run({ category: 'gift-cards', merchant: 'FlashDeal Outlet' });
  assert.equal(r.decision, 'denied');
  assert.equal(r.reasons.length, 2);
});

test('validateRules accepts the defaults', () => {
  assert.equal(validateRules(DEFAULT_RULES).ok, true);
});

test('validateRules rejects an auto-approve limit above the hard limit', () => {
  const r = validateRules({ ...DEFAULT_RULES, autoApproveLimitCents: 9000, hardLimitCents: 5000 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /cannot be higher/);
});

test('validateRules rejects non-integer, negative and unknown values', () => {
  assert.equal(validateRules({ ...DEFAULT_RULES, dailyBudgetCents: 12.5 }).ok, false);
  assert.equal(validateRules({ ...DEFAULT_RULES, hardLimitCents: -1 }).ok, false);
  assert.equal(validateRules({ ...DEFAULT_RULES, allowedCategories: ['weapons'] }).ok, false);
  assert.equal(validateRules(null).ok, false);
});

test('validateRules trims and de-duplicates the blocked merchants', () => {
  const r = validateRules({ ...DEFAULT_RULES, blockedMerchants: [' A ', 'A', ''] });
  assert.deepEqual(r.rules.blockedMerchants, ['A']);
});
