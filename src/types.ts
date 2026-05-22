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

export type PaymentCycle = 'first' | 'fifteenth';

export interface CycleBudget {
  cycle: PaymentCycle;
  income: number;
  expenses: number;
  balance: number;
  transactions: Transaction[];
}
