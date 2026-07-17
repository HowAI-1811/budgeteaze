import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getUtilization,
  getAvailableCredit,
  getDaysUntilDue,
  sanitizeCreditCard,
  sanitizeCardTransaction,
} from './creditCards';
import type { CreditCard, CardTransaction } from '../types';

const baseCard = (overrides: Partial<CreditCard> = {}): CreditCard => ({
  id: 'card-1',
  name: 'Chase Sapphire',
  last4: '1234',
  network: 'Visa',
  limit: 1000,
  balance: 250,
  minDue: 25,
  dueDate: '2026-06-15',
  stmtCloseDate: '2026-05-20',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

test('getUtilization returns balance/limit as a ratio', () => {
  assert.equal(getUtilization(baseCard({ limit: 1000, balance: 250 })), 0.25);
});

test('getUtilization returns null when no limit is set', () => {
  assert.equal(getUtilization(baseCard({ limit: 0, balance: 250 })), null);
});

test('getAvailableCredit returns remaining credit', () => {
  assert.equal(getAvailableCredit(baseCard({ limit: 1000, balance: 250 })), 750);
});

test('getAvailableCredit never goes negative when over limit', () => {
  assert.equal(getAvailableCredit(baseCard({ limit: 1000, balance: 1200 })), 0);
});

test('getDaysUntilDue counts whole days from a given date', () => {
  const card = baseCard({ dueDate: '2026-06-15' });
  assert.equal(getDaysUntilDue(card, new Date(2026, 5, 5)), 10);
});

test('getDaysUntilDue is negative when past due', () => {
  const card = baseCard({ dueDate: '2026-06-15' });
  assert.equal(getDaysUntilDue(card, new Date(2026, 5, 20)), -5);
});

test('getDaysUntilDue is zero on the due date', () => {
  const card = baseCard({ dueDate: '2026-06-15' });
  assert.equal(getDaysUntilDue(card, new Date(2026, 5, 15)), 0);
});

test('getDaysUntilDue returns null when no due date is set', () => {
  assert.equal(getDaysUntilDue(baseCard({ dueDate: '' }), new Date(2026, 5, 1)), null);
});

test('sanitizeCreditCard accepts a valid record', () => {
  const result = sanitizeCreditCard({
    id: 'c',
    name: 'Amex Gold',
    last4: '9999',
    network: 'Amex',
    limit: 5000,
    balance: 1000,
  });
  assert.ok(result);
  assert.equal(result.network, 'Amex');
  assert.equal(result.last4, '9999');
});

test('sanitizeCreditCard extracts trailing 4 digits and defaults an unknown network', () => {
  const result = sanitizeCreditCard({
    id: 'c',
    name: 'Store Card',
    last4: 'xx-1234-5678',
    network: 'Bogus',
    limit: 500,
    balance: 0,
  });
  assert.ok(result);
  assert.equal(result.last4, '5678');
  assert.equal(result.network, 'Other');
  assert.equal(result.minDue, 0);
});

test('sanitizeCreditCard rejects records missing required numeric fields', () => {
  assert.equal(sanitizeCreditCard(null), null);
  assert.equal(sanitizeCreditCard({ id: 'c', name: 'No numbers' }), null);
  assert.equal(
    sanitizeCreditCard({ id: 'c', name: 'Bad', limit: 'lots', balance: 0 }),
    null,
  );
});

test('sanitizeCardTransaction accepts a valid record and defaults posted/category', () => {
  const result = sanitizeCardTransaction({
    id: 't',
    cardId: 'card-1',
    description: 'Coffee',
    amount: 4.5,
    date: '2026-06-01',
  } satisfies Partial<CardTransaction> & Record<string, unknown>);
  assert.ok(result);
  assert.equal(result.posted, true);
  assert.equal(result.category, '');
});

test('sanitizeCardTransaction rejects invalid records', () => {
  assert.equal(sanitizeCardTransaction(null), null);
  assert.equal(sanitizeCardTransaction({ id: 't', cardId: 'card-1' }), null);
  assert.equal(
    sanitizeCardTransaction({
      id: 't',
      cardId: 'card-1',
      description: 'Missing amount',
      date: '2026-06-01',
    }),
    null,
  );
});
