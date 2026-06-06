export type TransactionType = 'debit' | 'credit';
export type AccountType = 'credit_card';

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
  accountType?: AccountType;
  accountName?: string;
  statementBalance?: number;
  currentBalance?: number;
  minimumPayment?: number;
  dueDate?: string;
  creditLimit?: number;
  interestRate?: number;
  lastStatementDate?: string;
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
  cancelledDate?: string; // ISO date — set when status → 'cancelled'
  trialEndDate?: string; // ISO date — free trial ends; charge begins after

  // Ledger integration
  autoCreateTransaction: boolean; // true → inject a Transaction each billing period

  // Optional metadata
  url?: string; // management/cancellation URL
  notes?: string;
  color?: string; // hex color token for UI badge
}

export type PaymentCycle = 'first' | 'fifteenth';

export interface CycleBudget {
  cycle: PaymentCycle;
  income: number;
  expenses: number;
  balance: number;
  transactions: Transaction[];
}
