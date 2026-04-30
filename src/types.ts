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
