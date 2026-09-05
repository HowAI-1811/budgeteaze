import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bankBalance, bankCashFlow, sanitizeBankAccount, sanitizeBankTransaction, saveBankAccounts, loadBankAccounts, saveBankTransactions, loadBankTransactions, type BankAccount, type BankTransaction } from './banking';
const meta = { createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' };
const checking: BankAccount = { id: 'checking', name: 'Checking', type: 'checking', startingBalance: 1000, ...meta };
const savings: BankAccount = { ...checking, id: 'savings', name: 'Savings', type: 'savings', startingBalance: 200 };
const txn: BankTransaction = { id: 't', accountId: 'checking', type: 'out', amount: 12.34, date: '2026-09-05', description: 'Groceries', category: 'Food', notes: '', ...meta };
test('money in/out and edits derive the balance in cents', () => {
  assert.equal(bankBalance(checking, [txn, { ...txn, id: 'deposit', type: 'in', amount: 0.1 }, { ...txn, id: 'deposit2', type: 'in', amount: 0.2 }]), 987.96);
  assert.equal(bankBalance(checking, [{ ...txn, amount: 20 }]), 980);
  assert.equal(bankBalance(checking, [{ ...txn, amount: 1200 }]), -200);
});
test('transfer updates both accounts and never counts as income or expense', () => {
  const transfer: BankTransaction = { ...txn, type: 'transfer', destinationId: 'savings', amount: 250 };
  assert.equal(bankBalance(checking, [transfer]), 750);
  assert.equal(bankBalance(savings, [transfer]), 450);
  assert.deepEqual(bankCashFlow([transfer]), { income: 0, expenses: 0 });
  const removed = { ...transfer, deletedAt: meta.updatedAt };
  assert.equal(bankBalance(checking, [removed]), 1000);
  assert.equal(bankBalance(savings, [removed]), 200);
  assert.deepEqual(bankCashFlow([txn, { ...txn, id: 'interest', type: 'in', amount: 5 }, removed]), { income: 5, expenses: 12.34 });
});
test('backup validation rejects invalid money and self transfers', () => {
  assert.equal(sanitizeBankAccount({ ...checking, startingBalance: Infinity }), null);
  assert.equal(sanitizeBankTransaction({ ...txn, amount: -1 }), null);
  assert.equal(sanitizeBankTransaction({ ...txn, type: 'transfer', destinationId: 'checking' }), null);
  assert.equal(sanitizeBankTransaction({ ...txn, date: 'invalid' }), null);
  assert.deepEqual(sanitizeBankAccount(checking), checking);
  assert.deepEqual(sanitizeBankTransaction(txn), txn);
});
test('accounts and transactions survive storage and JSON round trips', () => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) } });
  saveBankAccounts([checking, savings]); saveBankTransactions([txn]);
  assert.deepEqual(loadBankAccounts(), [checking, savings]);
  assert.deepEqual(loadBankTransactions(), [txn]);
  const backup = JSON.parse(JSON.stringify({ bankAccounts: loadBankAccounts(), bankTransactions: loadBankTransactions() }));
  assert.deepEqual(backup.bankAccounts.map(sanitizeBankAccount), [checking, savings]);
  assert.deepEqual(backup.bankTransactions.map(sanitizeBankTransaction), [txn]);
});
