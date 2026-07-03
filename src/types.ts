export type TransactionType = 'debit' | 'credit';

export interface Transaction {
  id: string;
  description: string;
  amount: number;
  type: TransactionType;
  date: string; // ISO string
  category?: string;
  isRecurring?: boolean;
  recurringId?: string;
  paid?: boolean;
  notes?: string;
}

/**
 * Sync metadata carried by every durable entity.
 *
 * These three fields are what a future multi-device sync layer needs:
 *  - `createdAt` / `updatedAt`: ISO timestamps powering last-write-wins merges.
 *  - `deletedAt`: a tombstone. Deletions become "set deletedAt" rather than a
 *    physical removal, so a delete on one device propagates instead of the
 *    record resurrecting from another device on the next sync.
 *
 * IDs are always client-generated UUIDs (`crypto.randomUUID()`), so a record is
 * fully identified before it ever reaches a server.
 */
export interface SyncMeta {
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp — bumped on every mutation
  deletedAt?: string; // ISO timestamp — present means soft-deleted (tombstone)
}

export type BillingCycle = 'weekly' | 'monthly' | 'quarterly' | 'annual';

export type SubscriptionStatus = 'active' | 'paused' | 'cancelled';

export interface Subscription extends SyncMeta {
  // Identity
  id: string; // crypto.randomUUID()
  name: string; // "Netflix", "Spotify Premium", "Planet Fitness"
  vendor?: string; // optional separate vendor field ("Netflix Inc.")

  // Billing
  amount: number; // cost per billingCycle
  billingCycle: BillingCycle;
  billingDay: number; // day-of-month for the charge (1–28; capped at 28)
  category?: string; // should match an entry in the categories list

  // Lifecycle
  status: SubscriptionStatus;
  startDate: string; // ISO date — first real charge date
  renewalDate?: string; // ISO date — user-specified next renewal date
  cancelledDate?: string; // ISO date — set when status → 'cancelled'
  trialEndDate?: string; // ISO date — free trial ends; charge begins after

  // Ledger integration
  autoCreateTransaction: boolean; // true → inject a Transaction each billing period

  // Credit card linkage
  cardId?: string; // FK → CreditCard.id; absent means not charged to a tracked card

  // Optional metadata
  url?: string; // management/cancellation URL
  notes?: string;
  color?: string; // hex color token for UI badge
}

export type CardNetwork = 'Visa' | 'Mastercard' | 'Amex' | 'Discover' | 'Other';

/**
 * A tracked credit card. Distinct from the bill-pay `Transaction`s in the
 * ledger (those record the monthly external payment). A `CreditCard` models what
 * is *on* the card — its balance, limit, and the charges/subscriptions against
 * it. `balance` is manually maintained for now (see spec §8).
 */
export interface CreditCard extends SyncMeta {
  id: string; // crypto.randomUUID()
  name: string; // e.g. "Chase Disney"
  last4: string; // last 4 digits
  network: CardNetwork;
  limit: number; // credit limit
  balance: number; // current balance (manually maintained)
  minDue: number; // minimum payment due
  dueDate: string; // ISO date string, e.g. "2026-06-15"
  stmtCloseDate: string; // ISO date string
  apr?: number;
  color?: string; // optional hex for card visual
}

/** An ad hoc charge (or payment) recorded against a tracked card. */
export interface CardTransaction extends SyncMeta {
  id: string; // crypto.randomUUID()
  cardId: string; // FK → CreditCard.id
  description: string;
  amount: number; // negative for payments
  date: string; // ISO date string
  category: string; // maps to an entry in the categories list
  posted: boolean; // true = confirmed charge, false = pending
  notes?: string;
}

export type PaymentCycle = 'first' | 'fifteenth';

export interface CycleBudget {
  cycle: PaymentCycle;
  income: number;
  expenses: number;
  balance: number;
  transactions: Transaction[];
}
