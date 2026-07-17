import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getMonthlyEquivalent,
  getNextBillingDate,
  subscriptionBillsInMonth,
  sanitizeSubscription,
} from './subscriptions';
import type { Subscription } from '../types';

const baseSub = (overrides: Partial<Subscription> = {}): Subscription => ({
  id: 'sub-1',
  name: 'Netflix',
  amount: 15,
  billingCycle: 'monthly',
  billingDay: 15,
  status: 'active',
  startDate: '2026-01-15',
  autoCreateTransaction: true,
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
  ...overrides,
});

test('getMonthlyEquivalent normalizes each billing cycle to a monthly cost', () => {
  assert.equal(getMonthlyEquivalent(baseSub({ amount: 12, billingCycle: 'weekly' })), (12 * 52) / 12);
  assert.equal(getMonthlyEquivalent(baseSub({ amount: 15, billingCycle: 'monthly' })), 15);
  assert.equal(getMonthlyEquivalent(baseSub({ amount: 30, billingCycle: 'quarterly' })), 10);
  assert.equal(getMonthlyEquivalent(baseSub({ amount: 120, billingCycle: 'annual' })), 10);
});

test('getNextBillingDate caps the billing day at 28', () => {
  // A far-future reference month keeps the result deterministic regardless of "today".
  const result = getNextBillingDate(
    baseSub({ billingDay: 31, billingCycle: 'monthly' }),
    new Date(2100, 5, 1),
  );
  assert.equal(result, '2100-06-28');
});

test('getNextBillingDate returns a valid yyyy-MM-dd string', () => {
  const result = getNextBillingDate(baseSub(), new Date(2100, 0, 1));
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('subscriptionBillsInMonth: monthly always bills once started', () => {
  const sub = baseSub({ billingCycle: 'monthly' });
  assert.equal(subscriptionBillsInMonth(sub, new Date(2026, 2, 1)), true);
  assert.equal(subscriptionBillsInMonth(sub, new Date(2026, 7, 1)), true);
});

test('subscriptionBillsInMonth: quarterly only bills every third month from the anchor', () => {
  // startDate is January (anchor month 0) → Jan, Apr, Jul, Oct.
  const sub = baseSub({ billingCycle: 'quarterly', startDate: '2026-01-15' });
  assert.equal(subscriptionBillsInMonth(sub, new Date(2026, 0, 1)), true); // Jan
  assert.equal(subscriptionBillsInMonth(sub, new Date(2026, 1, 1)), false); // Feb
  assert.equal(subscriptionBillsInMonth(sub, new Date(2026, 3, 1)), true); // Apr
  assert.equal(subscriptionBillsInMonth(sub, new Date(2026, 6, 1)), true); // Jul
});

test('subscriptionBillsInMonth: annual only bills in the anchor month', () => {
  const sub = baseSub({ billingCycle: 'annual', startDate: '2026-03-10' });
  assert.equal(subscriptionBillsInMonth(sub, new Date(2027, 2, 1)), true); // March
  assert.equal(subscriptionBillsInMonth(sub, new Date(2027, 3, 1)), false); // April
});

test('subscriptionBillsInMonth: renewalDate overrides startDate as the anchor', () => {
  // Signup in January, but the user corrected the renewal to March.
  const sub = baseSub({
    billingCycle: 'annual',
    startDate: '2026-01-15',
    renewalDate: '2026-03-15',
  });
  assert.equal(subscriptionBillsInMonth(sub, new Date(2027, 2, 1)), true); // March (renewal)
  assert.equal(subscriptionBillsInMonth(sub, new Date(2027, 0, 1)), false); // January (signup)
});

test('subscriptionBillsInMonth: suppressed while a trial is still running', () => {
  const sub = baseSub({ trialEndDate: '2026-12-31' });
  assert.equal(subscriptionBillsInMonth(sub, new Date(2026, 5, 1)), false);
});

test('subscriptionBillsInMonth: no charge before the subscription has started', () => {
  const sub = baseSub({ startDate: '2030-01-01' });
  assert.equal(subscriptionBillsInMonth(sub, new Date(2026, 0, 1)), false);
});

test('subscriptionBillsInMonth: paused, cancelled, opted-out, and deleted never bill', () => {
  const month = new Date(2026, 5, 1);
  assert.equal(subscriptionBillsInMonth(baseSub({ status: 'paused' }), month), false);
  assert.equal(subscriptionBillsInMonth(baseSub({ status: 'cancelled' }), month), false);
  assert.equal(subscriptionBillsInMonth(baseSub({ autoCreateTransaction: false }), month), false);
  assert.equal(subscriptionBillsInMonth(baseSub({ deletedAt: '2026-05-01T00:00:00.000Z' }), month), false);
});

test('sanitizeSubscription accepts a valid record and clamps billingDay to 1–28', () => {
  const result = sanitizeSubscription({
    id: 'x',
    name: 'Spotify',
    amount: 11,
    billingCycle: 'monthly',
    billingDay: 40,
    status: 'active',
    startDate: '2026-02-01',
  });
  assert.ok(result);
  assert.equal(result.billingDay, 28);
});

test('sanitizeSubscription clamps a too-small billingDay up to 1', () => {
  const result = sanitizeSubscription({
    id: 'x',
    name: 'Spotify',
    amount: 11,
    billingCycle: 'monthly',
    billingDay: 0,
    status: 'active',
    startDate: '2026-02-01',
  });
  assert.ok(result);
  assert.equal(result.billingDay, 1);
});

test('sanitizeSubscription rejects invalid records', () => {
  assert.equal(sanitizeSubscription(null), null);
  assert.equal(sanitizeSubscription({ id: 'x' }), null);
  assert.equal(
    sanitizeSubscription({
      id: 'x',
      name: 'Bad',
      amount: Number.NaN,
      billingCycle: 'monthly',
      billingDay: 1,
      status: 'active',
      startDate: '2026-02-01',
    }),
    null,
  );
  assert.equal(
    sanitizeSubscription({
      id: 'x',
      name: 'Bad cycle',
      amount: 5,
      billingCycle: 'daily',
      billingDay: 1,
      status: 'active',
      startDate: '2026-02-01',
    }),
    null,
  );
});

test('sanitizeSubscription drops malformed optional fields and defaults autoCreateTransaction', () => {
  const result = sanitizeSubscription({
    id: 'x',
    name: 'Spotify',
    amount: 11,
    billingCycle: 'monthly',
    billingDay: 5,
    status: 'active',
    startDate: '2026-02-01',
    vendor: 42, // wrong type → dropped
  });
  assert.ok(result);
  assert.equal(result.vendor, undefined);
  assert.equal(result.autoCreateTransaction, true);
});
