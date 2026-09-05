import type { SyncMeta } from '../types';
import { storage } from './storage';

export interface BankAccount extends SyncMeta {
  id: string;
  name: string;
  type: 'checking' | 'savings';
  startingBalance: number;
}

// A transfer is one record so both sides always change together.
export interface BankTransaction extends SyncMeta {
  id: string;
  accountId: string;
  destinationId?: string;
  type: 'in' | 'out' | 'transfer';
  amount: number;
  date: string;
  description: string;
  category: string;
  notes: string;
}

export const loadBankAccounts = () => storage.read<BankAccount[]>('cyclebudget_bank_accounts', []);
export const loadBankTransactions = () => storage.read<BankTransaction[]>('cyclebudget_bank_transactions', []);
export const saveBankAccounts = (value: BankAccount[]) => storage.write('cyclebudget_bank_accounts', value);
export const saveBankTransactions = (value: BankTransaction[]) => storage.write('cyclebudget_bank_transactions', value);
export const bankBalance = (account: BankAccount, transactions: BankTransaction[]) => {
  let cents = Math.round(account.startingBalance * 100);
  for (const t of transactions) {
    if (t.deletedAt) continue;
    const amount = Math.round(t.amount * 100);
    if (t.accountId === account.id) cents += t.type === 'in' ? amount : -amount;
    if (t.type === 'transfer' && t.destinationId === account.id) cents += amount;
  }
  return cents / 100;
};
export const bankCashFlow = (transactions: BankTransaction[]) => ({
  income: transactions.filter(t => !t.deletedAt && t.type === 'in').reduce((n, t) => n + Math.round(t.amount * 100), 0) / 100,
  expenses: transactions.filter(t => !t.deletedAt && t.type === 'out').reduce((n, t) => n + Math.round(t.amount * 100), 0) / 100,
});
const meta = (v: Record<string, unknown>) => ({
  createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date().toISOString(),
  updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : new Date().toISOString(),
  ...(typeof v.deletedAt === 'string' ? { deletedAt: v.deletedAt } : {}),
});
export function sanitizeBankAccount(value: unknown): BankAccount | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id || typeof v.name !== 'string' || !v.name.trim() ||
      !['checking', 'savings'].includes(String(v.type)) || typeof v.startingBalance !== 'number' || !Number.isFinite(v.startingBalance)) return null;
  return { id: v.id, name: v.name.trim(), type: v.type as BankAccount['type'], startingBalance: v.startingBalance, ...meta(v) };
}
export function sanitizeBankTransaction(value: unknown): BankTransaction | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id || typeof v.accountId !== 'string' || !v.accountId ||
      !['in', 'out', 'transfer'].includes(String(v.type)) || typeof v.amount !== 'number' || !Number.isFinite(v.amount) || v.amount <= 0 ||
      typeof v.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.date) || !Number.isFinite(Date.parse(v.date)) ||
      typeof v.description !== 'string' || !v.description.trim()) return null;
  if (v.type === 'transfer' && (typeof v.destinationId !== 'string' || !v.destinationId || v.destinationId === v.accountId)) return null;
  return { id: v.id, accountId: v.accountId, type: v.type as BankTransaction['type'],
    ...(v.type === 'transfer' ? { destinationId: v.destinationId as string } : {}),
    amount: v.amount, date: v.date, description: v.description.trim(),
    category: typeof v.category === 'string' ? v.category : '', notes: typeof v.notes === 'string' ? v.notes : '', ...meta(v) };
}
