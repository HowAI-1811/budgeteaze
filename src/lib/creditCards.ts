/**
 * Credit-card domain logic — framework-free, mirroring subscriptions.ts.
 *
 * Houses persistence keys, sync-aware record factories (create/touch/tombstone),
 * import sanitizers, and the derived math (utilization, days-until-due, cycle
 * posting) used by the Credit Card Dashboard. Keeping it here makes the logic
 * unit-testable and reusable by a future sync engine.
 */

import { parseISO } from 'date-fns';
import { storage } from './storage';
import type {
  CreditCard,
  CardTransaction,
  CardNetwork,
} from '../types';

export const CREDIT_CARDS_STORAGE_KEY = 'cyclebudget_credit_cards';
export const CARD_TRANSACTIONS_STORAGE_KEY = 'cyclebudget_card_transactions';

const nowIso = () => new Date().toISOString();

/** Fields the UI supplies; id + sync metadata are stamped by the factory. */
export type CreditCardInput = Omit<
  CreditCard,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;
export type CardTransactionInput = Omit<
  CardTransaction,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

// ── Persistence (routed through the swappable storage adapter) ──────────────

export const loadCreditCards = (): CreditCard[] =>
  storage.read<CreditCard[]>(CREDIT_CARDS_STORAGE_KEY, []);
export const saveCreditCards = (cards: CreditCard[]): void =>
  storage.write(CREDIT_CARDS_STORAGE_KEY, cards);

export const loadCardTransactions = (): CardTransaction[] =>
  storage.read<CardTransaction[]>(CARD_TRANSACTIONS_STORAGE_KEY, []);
export const saveCardTransactions = (txns: CardTransaction[]): void =>
  storage.write(CARD_TRANSACTIONS_STORAGE_KEY, txns);

// ── Sync-aware record lifecycle ─────────────────────────────────────────────

export const createCreditCard = (input: CreditCardInput): CreditCard => {
  const ts = nowIso();
  return { ...input, id: crypto.randomUUID(), createdAt: ts, updatedAt: ts };
};
export const createCardTransaction = (
  input: CardTransactionInput,
): CardTransaction => {
  const ts = nowIso();
  return { ...input, id: crypto.randomUUID(), createdAt: ts, updatedAt: ts };
};

/** Apply changes and bump `updatedAt` (the last-write-wins key). */
export const touchCreditCard = (
  card: CreditCard,
  changes: Partial<CreditCard>,
): CreditCard => ({ ...card, ...changes, updatedAt: nowIso() });
export const touchCardTransaction = (
  txn: CardTransaction,
  changes: Partial<CardTransaction>,
): CardTransaction => ({ ...txn, ...changes, updatedAt: nowIso() });

/** Soft delete: keep the record as a tombstone so the deletion can sync. */
export const tombstoneCreditCard = (card: CreditCard): CreditCard => ({
  ...card,
  deletedAt: nowIso(),
  updatedAt: nowIso(),
});
export const tombstoneCardTransaction = (
  txn: CardTransaction,
): CardTransaction => ({ ...txn, deletedAt: nowIso(), updatedAt: nowIso() });

/** A record the user should see (not soft-deleted). */
export const isLive = (rec: { deletedAt?: string }): boolean => !rec.deletedAt;

// ── Derived math ────────────────────────────────────────────────────────────

/** Utilization as a 0–1 ratio, or null when no limit is set. */
export const getUtilization = (card: CreditCard): number | null =>
  card.limit > 0 ? card.balance / card.limit : null;

export const getAvailableCredit = (card: CreditCard): number =>
  Math.max(card.limit - card.balance, 0);

/** Whole days from `from` until the card's due date (negative if past due). */
export const getDaysUntilDue = (
  card: CreditCard,
  from: Date = new Date(),
): number | null => {
  if (!card.dueDate) return null;
  const due = parseISO(card.dueDate);
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(due) - startOfDay(from)) / 86_400_000);
};

// ── Import validation ───────────────────────────────────────────────────────

const NETWORKS: CardNetwork[] = ['Visa', 'Mastercard', 'Amex', 'Discover', 'Other'];

const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

export const sanitizeCreditCard = (value: unknown): CreditCard | null => {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (
    !isString(c.id) ||
    !isString(c.name) ||
    !isFiniteNum(c.limit) ||
    !isFiniteNum(c.balance)
  ) {
    return null;
  }
  const ts = nowIso();
  return {
    id: c.id,
    name: c.name,
    last4: isString(c.last4) ? c.last4.replace(/\D/g, '').slice(-4) : '',
    network: NETWORKS.includes(c.network as CardNetwork)
      ? (c.network as CardNetwork)
      : 'Other',
    limit: c.limit,
    balance: c.balance,
    minDue: isFiniteNum(c.minDue) ? c.minDue : 0,
    dueDate: isString(c.dueDate) ? c.dueDate : '',
    stmtCloseDate: isString(c.stmtCloseDate) ? c.stmtCloseDate : '',
    apr: isFiniteNum(c.apr) ? c.apr : undefined,
    color: isString(c.color) ? c.color : undefined,
    createdAt: isString(c.createdAt) ? c.createdAt : ts,
    updatedAt: isString(c.updatedAt) ? c.updatedAt : ts,
    deletedAt: isString(c.deletedAt) ? c.deletedAt : undefined,
  };
};

export const sanitizeCardTransaction = (
  value: unknown,
): CardTransaction | null => {
  if (!value || typeof value !== 'object') return null;
  const t = value as Record<string, unknown>;
  if (
    !isString(t.id) ||
    !isString(t.cardId) ||
    !isString(t.description) ||
    !isFiniteNum(t.amount) ||
    !isString(t.date)
  ) {
    return null;
  }
  const ts = nowIso();
  return {
    id: t.id,
    cardId: t.cardId,
    description: t.description,
    amount: t.amount,
    date: t.date,
    category: isString(t.category) ? t.category : '',
    posted: typeof t.posted === 'boolean' ? t.posted : true,
    notes: isString(t.notes) ? t.notes : undefined,
    createdAt: isString(t.createdAt) ? t.createdAt : ts,
    updatedAt: isString(t.updatedAt) ? t.updatedAt : ts,
    deletedAt: isString(t.deletedAt) ? t.deletedAt : undefined,
  };
};
