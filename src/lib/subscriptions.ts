/**
 * Subscription domain logic — deliberately framework-free.
 *
 * Keeping billing math, the persistence key, the record factory, and the import
 * sanitizer out of App.tsx makes them unit-testable and, more importantly,
 * reusable by a future sync engine (which will need the same create/touch/
 * tombstone semantics server-side or in a worker).
 */

import { format, parseISO, endOfMonth } from 'date-fns';
import type { Subscription, BillingCycle, SubscriptionStatus } from '../types';
import { storage } from './storage';

export const SUBSCRIPTIONS_STORAGE_KEY = 'cyclebudget_subscriptions';

/** Fields the UI supplies; sync metadata + id are stamped by the factory. */
export type SubscriptionInput = Omit<
  Subscription,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

const nowIso = () => new Date().toISOString();

// ── Persistence (routed through the swappable storage adapter) ──────────────

export const loadSubscriptions = (): Subscription[] =>
  storage.read<Subscription[]>(SUBSCRIPTIONS_STORAGE_KEY, []);

export const saveSubscriptions = (subs: Subscription[]): void =>
  storage.write(SUBSCRIPTIONS_STORAGE_KEY, subs);

// ── Sync-aware record lifecycle ─────────────────────────────────────────────

export const createSubscription = (input: SubscriptionInput): Subscription => {
  const ts = nowIso();
  return {
    ...input,
    id: crypto.randomUUID(),
    createdAt: ts,
    updatedAt: ts,
  };
};

/** Apply changes and bump `updatedAt` (the last-write-wins key). */
export const touchSubscription = (
  sub: Subscription,
  changes: Partial<Subscription>,
): Subscription => ({
  ...sub,
  ...changes,
  updatedAt: nowIso(),
});

/** Soft delete: keep the record as a tombstone so the deletion can sync. */
export const tombstoneSubscription = (sub: Subscription): Subscription => ({
  ...sub,
  deletedAt: nowIso(),
  updatedAt: nowIso(),
});

/** A record the user should see (not soft-deleted). */
export const isLiveSubscription = (sub: Subscription): boolean => !sub.deletedAt;

// ── Billing math ────────────────────────────────────────────────────────────

export const getMonthlyEquivalent = (sub: Subscription): number => {
  switch (sub.billingCycle) {
    case 'weekly':
      return (sub.amount * 52) / 12;
    case 'monthly':
      return sub.amount;
    case 'quarterly':
      return sub.amount / 3;
    case 'annual':
      return sub.amount / 12;
    default:
      return sub.amount;
  }
};

/**
 * ISO date of the next charge relative to `referenceDate`, honoring the
 * subscription's cadence (weekly/monthly land every month; quarterly/annual
 * only land every 3rd/12th month counting from `startDate`). Day is capped
 * at 28. Only consults `startDate` — callers should prefer `renewalDate`
 * directly when the user has set one explicitly.
 */
export const getNextBillingDate = (
  sub: Subscription,
  referenceDate: Date,
): string => {
  const day = Math.min(sub.billingDay, 28);
  const today = new Date();

  if (sub.billingCycle === 'monthly' || sub.billingCycle === 'weekly') {
    const candidate = new Date(
      referenceDate.getFullYear(),
      referenceDate.getMonth(),
      day,
    );
    if (candidate < today) {
      candidate.setMonth(candidate.getMonth() + 1);
    }
    return format(candidate, 'yyyy-MM-dd');
  }

  // Quarterly/annual: walk forward from startDate in cycle-sized steps
  // until we reach the next occurrence on or after today.
  const monthsPerCycle = sub.billingCycle === 'quarterly' ? 3 : 12;
  const start = parseISO(sub.startDate);
  const candidate = new Date(start.getFullYear(), start.getMonth(), day);
  while (candidate < today) {
    candidate.setMonth(candidate.getMonth() + monthsPerCycle);
  }
  return format(candidate, 'yyyy-MM-dd');
};

/** Whether a subscription should generate a ledger transaction for `month`. */
export const subscriptionBillsInMonth = (
  sub: Subscription,
  month: Date,
): boolean => {
  if (!isLiveSubscription(sub)) return false;
  if (sub.status !== 'active') return false;
  if (!sub.autoCreateTransaction) return false;

  // Trial still running → no charge.
  if (sub.trialEndDate && parseISO(sub.trialEndDate) > endOfMonth(month)) {
    return false;
  }

  // Subscription hasn't started by the end of this month → no charge.
  if (parseISO(sub.startDate) > endOfMonth(month)) return false;

  // The user-editable renewal date, when set, is authoritative for which
  // month a quarterly/annual charge falls in — it's how you correct drift
  // between the original signup date and the actual billing month.
  const anchor = sub.renewalDate ? parseISO(sub.renewalDate) : parseISO(sub.startDate);

  switch (sub.billingCycle) {
    case 'weekly':
    case 'monthly':
      return true;
    case 'quarterly': {
      const anchorMonth = anchor.getMonth();
      const viewMonth = month.getMonth();
      return (viewMonth - anchorMonth + 12) % 3 === 0;
    }
    case 'annual':
      return format(month, 'MM') === format(anchor, 'MM');
    default:
      return false;
  }
};

// ── Import validation ─────────────────────────────────────────────────────

const BILLING_CYCLES: BillingCycle[] = ['weekly', 'monthly', 'quarterly', 'annual'];
const STATUSES: SubscriptionStatus[] = ['active', 'paused', 'cancelled'];

/**
 * Validate a raw object from a backup file. Tolerant by design: missing sync
 * metadata is back-filled (v1/older exports won't have it), and bad optional
 * fields are dropped rather than rejecting the record.
 */
export const sanitizeSubscription = (value: unknown): Subscription | null => {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;

  if (
    typeof s.id !== 'string' ||
    typeof s.name !== 'string' ||
    typeof s.amount !== 'number' ||
    !Number.isFinite(s.amount) ||
    !BILLING_CYCLES.includes(s.billingCycle as BillingCycle) ||
    typeof s.billingDay !== 'number' ||
    !STATUSES.includes(s.status as SubscriptionStatus) ||
    typeof s.startDate !== 'string'
  ) {
    return null;
  }

  const ts = nowIso();
  const isString = (v: unknown): v is string => typeof v === 'string';

  return {
    id: s.id,
    name: s.name,
    vendor: isString(s.vendor) ? s.vendor : undefined,
    amount: s.amount,
    billingCycle: s.billingCycle as BillingCycle,
    billingDay: Math.min(Math.max(Math.round(s.billingDay), 1), 28),
    category: isString(s.category) ? s.category : undefined,
    status: s.status as SubscriptionStatus,
    startDate: s.startDate,
    renewalDate: isString(s.renewalDate) ? s.renewalDate : undefined,
    cancelledDate: isString(s.cancelledDate) ? s.cancelledDate : undefined,
    trialEndDate: isString(s.trialEndDate) ? s.trialEndDate : undefined,
    autoCreateTransaction:
      typeof s.autoCreateTransaction === 'boolean'
        ? s.autoCreateTransaction
        : true,
    url: isString(s.url) ? s.url : undefined,
    notes: isString(s.notes) ? s.notes : undefined,
    color: isString(s.color) ? s.color : undefined,
    // Back-fill sync metadata for older exports that predate it.
    createdAt: isString(s.createdAt) ? s.createdAt : ts,
    updatedAt: isString(s.updatedAt) ? s.updatedAt : ts,
    deletedAt: isString(s.deletedAt) ? s.deletedAt : undefined,
  };
};
