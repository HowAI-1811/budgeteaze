/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useEffect, useRef, type ChangeEvent } from 'react';
import { 
  format, 
  startOfMonth, 
  endOfMonth, 
  addMonths, 
  subMonths,
  parseISO,
  isWithinInterval,
  getDate,
  isSameMonth
} from 'date-fns';
import { 
  Plus, 
  ChevronLeft, 
  ChevronRight,
  Trash2,
  Edit2,
  X,
  LayoutDashboard,
  Table as TableIcon,
  RefreshCw,
  Download,
  Upload,
  CheckCircle2,
  Circle,
  CreditCard,
  Repeat2,
  Globe,
  Pause,
  Play,
  Ban
} from 'lucide-react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  PieChart, 
  Pie, 
  Cell,
  LineChart,
  Line,
  Legend
} from 'recharts';
import { cn } from './lib/utils';
import { Transaction, TransactionType, Subscription, SubscriptionStatus, BillingCycle } from './types';
import {
  SUBSCRIPTIONS_STORAGE_KEY,
  loadSubscriptions,
  saveSubscriptions,
  createSubscription,
  touchSubscription,
  tombstoneSubscription,
  isLiveSubscription,
  getMonthlyEquivalent,
  getNextBillingDate,
  subscriptionBillsInMonth,
  sanitizeSubscription,
  type SubscriptionInput,
} from './lib/subscriptions';

const STORAGE_KEY = 'cyclebudget_data';
const CATEGORY_STORAGE_KEY = 'cyclebudget_categories';
type ViewType = 'ledger' | 'dashboard' | 'creditCards' | 'recurring' | 'subscriptions' | 'categories';

type TrendPoint = {
  name: string;
  Income: number;
  Expenses: number;
  Balance: number;
  hasActivity: boolean;
};

type TransactionComparison = {
  previousAmount: number | null;
  delta: number | null;
};

type MonthComparison = {
  previousMonthLabel: string;
  incomeDelta: number;
  expensesDelta: number;
  balanceDelta: number;
  savingsRateDelta: number | null;
  transactions: Record<string, TransactionComparison>;
};

type CreditCardSummary = {
  key: string;
  accountName: string;
  currentBalance: number;
  statementBalance: number;
  minimumPayment: number;
  plannedPayment: number;
  dueDate?: string;
  creditLimit?: number;
  interestRate?: number;
  utilization: number | null;
  paid: boolean;
  transaction: Transaction;
};

const formatMoney = (value: number) => {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2 });
};

function CashFlowTooltip({ active, payload, label }: any) {
  const point = payload?.[0]?.payload as TrendPoint | undefined;

  if (!active || !point?.hasActivity) return null;

  return (
    <div className="rounded-lg bg-white px-4 py-3 shadow-lg border border-slate-100">
      <p className="text-sm font-semibold text-slate-900 mb-2">{label}</p>
      <div className="space-y-1 text-xs font-mono">
        <p className="text-emerald-600">Income: ${formatMoney(point.Income)}</p>
        <p className="text-rose-600">Expenses: ${formatMoney(point.Expenses)}</p>
      </div>
    </div>
  );
}

const getSavingsRate = (income: number, balance: number) => {
  return income > 0 ? balance / income : 0;
};

const getOptionalNumber = (value: unknown) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const parseOptionalNumberInput = (value: string) => {
  if (!value.trim()) return undefined;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeMatchPart = (value?: string) => value?.trim().toLowerCase() || 'uncategorized';

const isCreditCardTransaction = (transaction: Transaction) => transaction.accountType === 'credit_card';

const getTransactionMatchKey = (transaction: Transaction) => {
  if (transaction.recurringId) {
    return `recurring:${transaction.recurringId}`;
  }

  return [
    'manual',
    normalizeMatchPart(transaction.description),
    normalizeMatchPart(transaction.category),
    transaction.type
  ].join(':');
};

const getDeltaTone = (delta: number, type: TransactionType | 'balance' | 'savings') => {
  if (Math.abs(delta) < 0.005) return 'text-slate-400';
  if (type === 'debit') return delta > 0 ? 'text-rose-600' : 'text-emerald-600';
  return delta > 0 ? 'text-emerald-600' : 'text-rose-600';
};

function MoneyDelta({ delta, toneType, label }: {
  delta: number | null;
  toneType: TransactionType | 'balance' | 'savings';
  label: string;
}) {
  if (delta === null) {
    return <span className="font-mono text-[10px] font-bold text-slate-400">No prior {label}</span>;
  }

  const isFlat = Math.abs(delta) < 0.005;
  const prefix = delta > 0 ? '+' : delta < 0 ? '-' : '';

  return (
    <span className={cn("font-mono text-[10px] font-bold", getDeltaTone(delta, toneType))}>
      {isFlat ? 'No change' : `${prefix}$${formatMoney(Math.abs(delta))}`} vs {label}
    </span>
  );
}

function PercentDelta({ delta, label }: { delta: number | null; label: string }) {
  if (delta === null) {
    return <span className="font-mono text-[10px] font-bold text-slate-400">No prior {label}</span>;
  }

  const percentagePoints = Math.round(delta * 100);
  const prefix = percentagePoints > 0 ? '+' : '';

  return (
    <span className={cn("font-mono text-[10px] font-bold", getDeltaTone(delta, 'savings'))}>
      {percentagePoints === 0 ? 'No change' : `${prefix}${percentagePoints} pts`} vs {label}
    </span>
  );
}

function PaymentPosture({ amount, minimumPayment }: { amount: number; minimumPayment?: number }) {
  if (!minimumPayment || minimumPayment <= 0) return null;

  const difference = amount - minimumPayment;
  if (Math.abs(difference) < 0.005) {
    return <span className="text-slate-400">Minimum only</span>;
  }

  return (
    <span className={difference > 0 ? 'text-emerald-600' : 'text-rose-600'}>
      {difference > 0 ? 'Above minimum' : 'Below minimum'}
    </span>
  );
}

const getDefaultEntryDate = (referenceDate: Date) => {
  const today = new Date();
  // If we're viewing the current month, default to today's date so entries
  // land in the correct cycle (1st-14th vs 15th-end). Otherwise fall back
  // to the 1st of the reference month.
  if (isSameMonth(today, referenceDate)) {
    return format(today, 'yyyy-MM-dd');
  }
  return format(startOfMonth(referenceDate), 'yyyy-MM-dd');
};

// Loosely validates a raw JSON object as a Transaction, tolerating minor
// field differences from older backup versions (e.g. null instead of undefined
// for optional fields).  Returns a cleaned Transaction or null if the core
// required fields are missing / wrong type.
const sanitizeTransaction = (value: unknown): Transaction | null => {
  if (!value || typeof value !== 'object') return null;
  const t = value as Record<string, unknown>;

  if (
    typeof t.id !== 'string' ||
    typeof t.description !== 'string' ||
    typeof t.amount !== 'number' ||
    !Number.isFinite(t.amount) ||
    (t.type !== 'debit' && t.type !== 'credit') ||
    typeof t.date !== 'string' ||
    Number.isNaN(Date.parse(t.date))
  ) {
    return null;
  }

  return {
    id: t.id as string,
    description: t.description as string,
    amount: t.amount as number,
    type: t.type as 'debit' | 'credit',
    date: t.date as string,
    // Tolerate null / undefined / missing for optional fields
    category: typeof t.category === 'string' ? t.category : undefined,
    isRecurring: typeof t.isRecurring === 'boolean' ? t.isRecurring : false,
    recurringId: typeof t.recurringId === 'string' ? t.recurringId : undefined,
    paid: typeof t.paid === 'boolean' ? t.paid : false,
    notes: typeof t.notes === 'string' ? t.notes : undefined,
    accountType: t.accountType === 'credit_card' ? 'credit_card' : undefined,
    accountName: typeof t.accountName === 'string' ? t.accountName : undefined,
    statementBalance: getOptionalNumber(t.statementBalance),
    currentBalance: getOptionalNumber(t.currentBalance),
    minimumPayment: getOptionalNumber(t.minimumPayment),
    dueDate: typeof t.dueDate === 'string' && !Number.isNaN(Date.parse(t.dueDate)) ? t.dueDate : undefined,
    creditLimit: getOptionalNumber(t.creditLimit),
    interestRate: getOptionalNumber(t.interestRate),
    lastStatementDate: typeof t.lastStatementDate === 'string' && !Number.isNaN(Date.parse(t.lastStatementDate)) ? t.lastStatementDate : undefined,
  };
};

const getTransactionsFromBackup = (backup: unknown): Transaction[] | null => {
  const raw = Array.isArray(backup)
    ? backup
    : backup && typeof backup === 'object' && Array.isArray((backup as { transactions?: unknown }).transactions)
      ? (backup as { transactions: unknown[] }).transactions
      : null;

  if (!raw) return null;

  const sanitized: Transaction[] = [];
  for (const item of raw) {
    const t = sanitizeTransaction(item);
    if (!t) return null; // one bad record → reject whole file
    sanitized.push(t);
  }

  return sanitized;
};

const getCategoriesFromBackup = (backup: unknown, transactions: Transaction[]): string[] => {
  const backupCategories = backup && typeof backup === 'object'
    ? (backup as { categories?: unknown }).categories
    : null;

  if (Array.isArray(backupCategories) && backupCategories.every(category => typeof category === 'string')) {
    return Array.from(new Set(backupCategories.map(category => category.trim()).filter(Boolean))).sort();
  }

  return Array.from(new Set(transactions.map(transaction => transaction.category?.trim()).filter(Boolean) as string[])).sort();
};

export default function App() {
  const [activeView, setActiveView] = useState<ViewType>('ledger');
  const [transactions, setTransactions] = useState<Transaction[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  });
  const [categories, setCategories] = useState<string[]>(() => {
    const saved = localStorage.getItem(CATEGORY_STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  });
  // Raw list includes soft-deleted tombstones (kept for future sync).
  const [subscriptions, setSubscriptions] = useState<Subscription[]>(() => loadSubscriptions());

  const [currentDate, setCurrentDate] = useState(new Date());
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);

  // Form State
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState<TransactionType>('debit');
  const [date, setDate] = useState(() => getDefaultEntryDate(currentDate));
  const [isRecurring, setIsRecurring] = useState(false);
  const [paid, setPaid] = useState(false);
  const [updateSeries, setUpdateSeries] = useState(false);
  const [notes, setNotes] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [isCreditCard, setIsCreditCard] = useState(false);
  const [accountName, setAccountName] = useState('');
  const [statementBalance, setStatementBalance] = useState('');
  const [currentBalance, setCurrentBalance] = useState('');
  const [minimumPayment, setMinimumPayment] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [creditLimit, setCreditLimit] = useState('');
  const [interestRate, setInterestRate] = useState('');
  const [lastStatementDate, setLastStatementDate] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
  }, [transactions]);

  useEffect(() => {
    localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(categories));
  }, [categories]);

  useEffect(() => {
    saveSubscriptions(subscriptions);
  }, [subscriptions]);

  // Live (non-tombstoned) subscriptions — what every view and the injection
  // logic should operate on. The raw `subscriptions` array is only for
  // persistence + the recurring-effect guard below.
  const visibleSubscriptions = useMemo(
    () => subscriptions.filter(isLiveSubscription),
    [subscriptions],
  );

  // All subscription ids ever created (incl. tombstones). Used to stop the
  // legacy recurring-injection effect from treating subscription-generated
  // transactions as manual recurring series.
  const subscriptionIds = useMemo(
    () => new Set(subscriptions.map(s => s.id)),
    [subscriptions],
  );

  const activeSubscriptions = useMemo(
    () => visibleSubscriptions.filter(s => s.status === 'active'),
    [visibleSubscriptions],
  );

  const subscriptionMonthlyTotal = useMemo(
    () => activeSubscriptions.reduce((sum, s) => sum + getMonthlyEquivalent(s), 0),
    [activeSubscriptions],
  );

  useEffect(() => {
    if (!editingTransaction) {
      setDate(getDefaultEntryDate(currentDate));
    }
  }, [currentDate, editingTransaction]);

  // Recurring Transaction Logic: Auto-populate for current month if missing.
  // IMPORTANT: Only depends on currentDate — NOT transactions.length.
  // Using the functional updater form of setTransactions so we always read
  // the latest state rather than a stale closure, which previously caused a
  // race condition in React StrictMode that swallowed freshly added entries.
  useEffect(() => {
    setTransactions(prev => {
      const uniqueRecurringIds = Array.from(new Set(
        prev
          // Skip transactions owned by a subscription — those are injected by
          // the dedicated subscription effect below, not cloned month-to-month.
          .filter(t => t.isRecurring && t.recurringId && !subscriptionIds.has(t.recurringId))
          .map(t => t.recurringId!)
      ));

      if (uniqueRecurringIds.length === 0) return prev;

      const currentMonthStr = format(currentDate, 'yyyy-MM');
      const existingInMonth = prev.filter(t => t.date.startsWith(currentMonthStr));

      const missingRecurring = uniqueRecurringIds
        .filter(rid => !existingInMonth.some(t => t.recurringId === rid))
        .map(rid => {
          const series = prev
            .filter(t => t.recurringId === rid)
            .sort((a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime());
          return series[0];
        });

      if (missingRecurring.length === 0) return prev;

      const newEntries = missingRecurring.map(template => {
        const originalDate = parseISO(template.date);
        const dayOfMonth = getDate(originalDate);
        const targetDate = format(
          new Date(currentDate.getFullYear(), currentDate.getMonth(), dayOfMonth),
          'yyyy-MM-dd'
        );
        return { ...template, id: crypto.randomUUID(), date: targetDate, paid: false };
      });

      return [...prev, ...newEntries];
    });
  }, [currentDate, subscriptionIds]);

  // Subscription auto-injection: for the viewed month, create a ledger
  // transaction for each active subscription that bills this month and doesn't
  // already have one. Mirrors the StrictMode-safe pattern above: functional
  // updater + missing-check, so double-invocation can't duplicate entries.
  useEffect(() => {
    setTransactions(prev => {
      const due = visibleSubscriptions.filter(sub =>
        subscriptionBillsInMonth(sub, currentDate)
      );
      if (due.length === 0) return prev;

      const currentMonthStr = format(currentDate, 'yyyy-MM');
      const existingInMonth = prev.filter(t => t.date.startsWith(currentMonthStr));

      const missing = due.filter(sub =>
        !existingInMonth.some(t => t.recurringId === sub.id)
      );
      if (missing.length === 0) return prev;

      const newEntries: Transaction[] = missing.map(sub => {
        const billingDay = Math.min(sub.billingDay, 28);
        const targetDate = format(
          new Date(currentDate.getFullYear(), currentDate.getMonth(), billingDay),
          'yyyy-MM-dd'
        );
        return {
          id: crypto.randomUUID(),
          description: sub.name,
          amount: sub.amount,
          type: 'debit' as const,
          date: targetDate,
          category: sub.category,
          isRecurring: true,
          recurringId: sub.id,
          paid: false,
          notes: sub.notes,
        };
      });

      return [...prev, ...newEntries];
    });
  }, [currentDate, visibleSubscriptions]);

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);

  const monthTransactions = useMemo(() => {
    return transactions.filter(t => {
      const tDate = parseISO(t.date);
      return isWithinInterval(tDate, { start: monthStart, end: monthEnd });
    });
  }, [transactions, monthStart, monthEnd]);

  const cycles = useMemo(() => {
    const firstCycle = monthTransactions.filter(t => {
      const tDate = parseISO(t.date);
      return tDate.getDate() < 15;
    });

    const secondCycle = monthTransactions.filter(t => {
      const tDate = parseISO(t.date);
      return tDate.getDate() >= 15;
    });

    const calculateStats = (ts: Transaction[]) => {
      const income = ts.filter(t => t.type === 'credit').reduce((sum, t) => sum + t.amount, 0);
      const expenses = ts.filter(t => t.type === 'debit').reduce((sum, t) => sum + t.amount, 0);
      return { income, expenses, balance: income - expenses, volume: income + expenses };
    };

    return {
      first: {
        transactions: firstCycle,
        ...calculateStats(firstCycle)
      },
      second: {
        transactions: secondCycle,
        ...calculateStats(secondCycle)
      }
    };
  }, [monthTransactions]);

  const handleAddOrUpdate = (e: import('react').FormEvent) => {
    e.preventDefault();
    const parsedAmount = amount.trim() ? parseFloat(amount) : 0;
    if (!description || (!isCreditCard && !amount.trim()) || !Number.isFinite(parsedAmount)) return;

    const recurringId = editingTransaction?.recurringId || (isRecurring ? crypto.randomUUID() : undefined);
    const trimmedAccountName = accountName.trim();

    const newTransaction: Transaction = {
      id: editingTransaction?.id || crypto.randomUUID(),
      description,
      amount: parsedAmount,
      category,
      type,
      date,
      isRecurring,
      recurringId,
      paid,
      notes,
      accountType: isCreditCard ? 'credit_card' : undefined,
      accountName: isCreditCard ? trimmedAccountName || description : undefined,
      statementBalance: isCreditCard ? parseOptionalNumberInput(statementBalance) : undefined,
      currentBalance: isCreditCard ? parseOptionalNumberInput(currentBalance) : undefined,
      minimumPayment: isCreditCard ? parseOptionalNumberInput(minimumPayment) : undefined,
      dueDate: isCreditCard && dueDate ? dueDate : undefined,
      creditLimit: isCreditCard ? parseOptionalNumberInput(creditLimit) : undefined,
      interestRate: isCreditCard ? parseOptionalNumberInput(interestRate) : undefined,
      lastStatementDate: isCreditCard && lastStatementDate ? lastStatementDate : undefined,
    };

    if (editingTransaction) {
      if (updateSeries && recurringId) {
        // Update all historical and future instances of this recurring series
        setTransactions(prev => prev.map(t => {
          if (t.recurringId === recurringId) {
            return {
              ...t,
              description,
              amount: parsedAmount,
              category,
              type,
              notes,
              isRecurring: true, // Keep it recurring
              accountType: isCreditCard ? 'credit_card' : undefined,
              accountName: isCreditCard ? trimmedAccountName || description : undefined,
              statementBalance: isCreditCard ? parseOptionalNumberInput(statementBalance) : undefined,
              currentBalance: isCreditCard ? parseOptionalNumberInput(currentBalance) : undefined,
              minimumPayment: isCreditCard ? parseOptionalNumberInput(minimumPayment) : undefined,
              dueDate: isCreditCard && dueDate ? dueDate : undefined,
              creditLimit: isCreditCard ? parseOptionalNumberInput(creditLimit) : undefined,
              interestRate: isCreditCard ? parseOptionalNumberInput(interestRate) : undefined,
              lastStatementDate: isCreditCard && lastStatementDate ? lastStatementDate : undefined,
            };
          }
          return t;
        }));
      } else {
        setTransactions(prev => prev.map(t => t.id === editingTransaction.id ? newTransaction : t));
      }
    } else {
      setTransactions(prev => [...prev, newTransaction]);
    }

    resetForm({ preserveDate: true });
  };

  const resetForm = ({ preserveDate = false }: { preserveDate?: boolean } = {}) => {
    setDescription('');
    setAmount('');
    setCategory('');
    setType('debit');
    if (!preserveDate) {
      setDate(getDefaultEntryDate(currentDate));
    }
    setIsRecurring(false);
    setPaid(false);
    setUpdateSeries(false);
    setNotes('');
    setIsCreditCard(false);
    setAccountName('');
    setStatementBalance('');
    setCurrentBalance('');
    setMinimumPayment('');
    setDueDate('');
    setCreditLimit('');
    setInterestRate('');
    setLastStatementDate('');
    setEditingTransaction(null);
  };

  const deleteTransaction = (id: string, cascade: boolean = false) => {
    const t = transactions.find(tx => tx.id === id);
    if (cascade && t?.recurringId) {
      setTransactions(prev => prev.filter(tx => tx.recurringId !== t.recurringId));
    } else {
      setTransactions(prev => prev.filter(tx => tx.id !== id));
    }
  };

  const togglePaid = (id: string) => {
    setTransactions(prev => prev.map(t => (
      t.id === id ? { ...t, paid: !t.paid } : t
    )));
  };

  const editTransaction = (t: Transaction) => {
    setDescription(t.description);
    setAmount(t.amount.toString());
    setCategory(t.category || '');
    setType(t.type);
    setDate(format(parseISO(t.date), 'yyyy-MM-dd'));
    setIsRecurring(!!t.isRecurring);
    setPaid(!!t.paid);
    setUpdateSeries(false);
    setNotes(t.notes || '');
    setIsCreditCard(isCreditCardTransaction(t));
    setAccountName(t.accountName || '');
    setStatementBalance(t.statementBalance?.toString() || '');
    setCurrentBalance(t.currentBalance?.toString() || '');
    setMinimumPayment(t.minimumPayment?.toString() || '');
    setDueDate(t.dueDate || '');
    setCreditLimit(t.creditLimit?.toString() || '');
    setInterestRate(t.interestRate?.toString() || '');
    setLastStatementDate(t.lastStatementDate || '');
    setEditingTransaction(t);
  };

  const addCategory = () => {
    const nextCategory = newCategory.trim();
    if (!nextCategory) return;

    setCategories(prev => {
      if (prev.some(category => category.toLowerCase() === nextCategory.toLowerCase())) {
        return prev;
      }

      return [...prev, nextCategory].sort((a, b) => a.localeCompare(b));
    });
    setNewCategory('');
  };

  const deleteCategory = (categoryToDelete: string) => {
    setCategories(prev => prev.filter(category => category !== categoryToDelete));
    if (category === categoryToDelete) {
      setCategory('');
    }
  };

  const addSubscription = (input: SubscriptionInput) => {
    setSubscriptions(prev => [...prev, createSubscription(input)]);
  };

  const updateSubscription = (id: string, changes: Partial<Subscription>) => {
    setSubscriptions(prev =>
      prev.map(s => (s.id === id ? touchSubscription(s, changes) : s))
    );
  };

  // Soft delete (tombstone) so the deletion can sync later. Optionally cascade
  // to the ledger transactions this subscription generated.
  const deleteSubscription = (id: string, deleteTransactions: boolean = false) => {
    setSubscriptions(prev =>
      prev.map(s => (s.id === id ? tombstoneSubscription(s) : s))
    );
    if (deleteTransactions) {
      setTransactions(prev => prev.filter(t => t.recurringId !== id));
    }
  };

  const changeSubscriptionStatus = (id: string, status: SubscriptionStatus) => {
    setSubscriptions(prev =>
      prev.map(s =>
        s.id === id
          ? touchSubscription(s, {
              status,
              cancelledDate:
                status === 'cancelled'
                  ? format(new Date(), 'yyyy-MM-dd')
                  : s.cancelledDate,
            })
          : s
      )
    );
  };

  const handleExportCSV = () => {
    const headers = [
      'Date',
      'Description',
      'Category',
      'Type',
      'Amount',
      'Paid',
      'Recurring',
      'Account Type',
      'Account Name',
      'Current Balance',
      'Statement Balance',
      'Minimum Payment',
      'Due Date',
      'Credit Limit',
      'APR',
      'Last Statement Date',
      'Notes'
    ];
    const csvRows = monthTransactions.map(t => [
      t.date,
      `"${t.description.replace(/"/g, '""')}"`,
      `"${(t.category || '').replace(/"/g, '""')}"`,
      t.type.toUpperCase(),
      t.amount.toFixed(2),
      t.paid ? 'Yes' : 'No',
      t.isRecurring ? 'Yes' : 'No',
      t.accountType || '',
      `"${(t.accountName || '').replace(/"/g, '""')}"`,
      t.currentBalance?.toFixed(2) || '',
      t.statementBalance?.toFixed(2) || '',
      t.minimumPayment?.toFixed(2) || '',
      t.dueDate || '',
      t.creditLimit?.toFixed(2) || '',
      t.interestRate?.toFixed(2) || '',
      t.lastStatementDate || '',
      `"${(t.notes || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = [headers.join(','), ...csvRows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `cyclebudget_export_${format(currentDate, 'yyyy_MM')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExportJSON = () => {
    const backup = {
      version: 2,
      exportedAt: new Date().toISOString(),
      categories,
      subscriptions,
      transactions,
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `cyclebudget_backup_${format(new Date(), 'yyyy_MM_dd')}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleImportJSON = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) return;

    try {
      const backup = JSON.parse(await file.text());
      const importedTransactions = getTransactionsFromBackup(backup);

      if (!importedTransactions) {
        alert('That JSON file does not look like a CycleBudget backup.\n\nMake sure you are using a file exported with the "Backup JSON" button.');
        return;
      }

      if (importedTransactions.length === 0) {
        alert('The backup file contained no transactions.');
        return;
      }

      const importedCategories = getCategoriesFromBackup(backup, importedTransactions);

      // Subscriptions are optional (absent in v1 files → []). Unlike
      // transactions, a single bad subscription record is skipped rather than
      // rejecting the whole file.
      const rawSubs = Array.isArray((backup as { subscriptions?: unknown }).subscriptions)
        ? (backup as { subscriptions: unknown[] }).subscriptions
        : [];
      const importedSubscriptions: Subscription[] = [];
      for (const item of rawSubs) {
        const sub = sanitizeSubscription(item);
        if (sub) importedSubscriptions.push(sub);
      }

      const shouldReplace = confirm(
        `Import ${importedTransactions.length} transactions, ${importedCategories.length} categories, and ${importedSubscriptions.length} subscriptions?\nThis will replace your current saved data.`
      );

      if (shouldReplace) {
        // Set transactions directly — use a stable reference so the recurring
        // useEffect (which runs on currentDate changes only) does not fire and
        // double-add entries that were just imported.
        const deduped = Array.from(
          new Map(importedTransactions.map(t => [t.id, t])).values()
        );
        setTransactions(deduped);
        setCategories(importedCategories);
        setSubscriptions(importedSubscriptions);
        resetForm();
        // Brief confirmation so the user knows import succeeded
        setTimeout(() =>
          alert(`✓ Imported ${deduped.length} transactions and ${importedCategories.length} categories successfully.`)
        , 100);
      }
    } catch (err) {
      console.error('Import failed:', err);
      alert('Could not read that JSON file. Please choose a valid backup file.');
    }
  };

  const totalIncome = cycles.first.income + cycles.second.income;
  const totalExpenses = cycles.first.expenses + cycles.second.expenses;
  const totalBalance = totalIncome - totalExpenses;
  const savingsRate = getSavingsRate(totalIncome, totalBalance);

  const monthComparison = useMemo<MonthComparison>(() => {
    const previousDate = subMonths(currentDate, 1);
    const previousStart = startOfMonth(previousDate);
    const previousEnd = endOfMonth(previousDate);
    const previousMonthTransactions = transactions.filter(t => {
      const tDate = parseISO(t.date);
      return isWithinInterval(tDate, { start: previousStart, end: previousEnd });
    });

    const previousIncome = previousMonthTransactions
      .filter(t => t.type === 'credit')
      .reduce((sum, t) => sum + t.amount, 0);
    const previousExpenses = previousMonthTransactions
      .filter(t => t.type === 'debit')
      .reduce((sum, t) => sum + t.amount, 0);
    const previousBalance = previousIncome - previousExpenses;
    const previousSavingsRate = getSavingsRate(previousIncome, previousBalance);

    const previousAmountsByKey = previousMonthTransactions.reduce<Record<string, number>>((acc, transaction) => {
      const key = getTransactionMatchKey(transaction);
      acc[key] = (acc[key] || 0) + transaction.amount;
      return acc;
    }, {});

    const transactionComparisons = monthTransactions.reduce<Record<string, TransactionComparison>>((acc, transaction) => {
      const previousAmount = previousAmountsByKey[getTransactionMatchKey(transaction)];
      acc[transaction.id] = {
        previousAmount: previousAmount ?? null,
        delta: previousAmount === undefined ? null : transaction.amount - previousAmount,
      };
      return acc;
    }, {});

    return {
      previousMonthLabel: format(previousDate, 'MMM'),
      incomeDelta: totalIncome - previousIncome,
      expensesDelta: totalExpenses - previousExpenses,
      balanceDelta: totalBalance - previousBalance,
      savingsRateDelta: previousIncome > 0 || totalIncome > 0 ? savingsRate - previousSavingsRate : null,
      transactions: transactionComparisons,
    };
  }, [currentDate, monthTransactions, transactions, totalIncome, totalExpenses, totalBalance, savingsRate]);

  const creditCardSummaries = useMemo<CreditCardSummary[]>(() => {
    const latestByAccount = new Map<string, CreditCardSummary>();

    monthTransactions
      .filter(isCreditCardTransaction)
      .sort((a, b) => parseISO(a.date).getTime() - parseISO(b.date).getTime())
      .forEach(transaction => {
        const accountName = transaction.accountName?.trim() || transaction.description;
        const key = accountName.toLowerCase();
        const currentBalance = transaction.currentBalance || 0;
        const creditLimit = transaction.creditLimit;
        const existing = latestByAccount.get(key);
        const plannedPayment = (existing?.plannedPayment || 0) + transaction.amount;

        latestByAccount.set(key, {
          key,
          accountName,
          currentBalance,
          statementBalance: transaction.statementBalance || 0,
          minimumPayment: transaction.minimumPayment || 0,
          plannedPayment,
          dueDate: transaction.dueDate,
          creditLimit,
          interestRate: transaction.interestRate,
          utilization: creditLimit && creditLimit > 0 ? currentBalance / creditLimit : null,
          paid: !!transaction.paid,
          transaction,
        });
      });

    return Array.from(latestByAccount.values()).sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return a.accountName.localeCompare(b.accountName);
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return parseISO(a.dueDate).getTime() - parseISO(b.dueDate).getTime();
    });
  }, [monthTransactions]);

  // Dashboard Data Preparation
  const dashboardData = useMemo(() => {
    const categoryMap: Record<string, number> = {};
    monthTransactions.forEach(t => {
      if (t.type === 'debit') {
        const cat = t.category || 'Uncategorized';
        categoryMap[cat] = (categoryMap[cat] || 0) + t.amount;
      }
    });

    const pieData = Object.entries(categoryMap).map(([name, value]) => ({ name, value }));
    
    // Last 6 months trend
    const trendData: TrendPoint[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = subMonths(currentDate, i);
      const start = startOfMonth(d);
      const end = endOfMonth(d);
      const periodTs = transactions.filter(t => isWithinInterval(parseISO(t.date), { start, end }));
      
      const income = periodTs.filter(t => t.type === 'credit').reduce((sum, t) => sum + t.amount, 0);
      const expenses = periodTs.filter(t => t.type === 'debit').reduce((sum, t) => sum + t.amount, 0);
      
      trendData.push({
        name: format(d, 'MMM'),
        Income: income,
        Expenses: expenses,
        Balance: income - expenses,
        hasActivity: periodTs.length > 0
      });
    }

    return { pieData, trendData };
  }, [monthTransactions, transactions, currentDate]);

  const COLORS = ['#2563EB', '#7C3AED', '#DB2777', '#EA580C', '#F59E0B', '#10B981', '#06B6D4', '#6366F1'];

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-50">
      {/* Header Section */}
      <header className="border-b border-slate-200 px-5 py-3 flex flex-wrap justify-between items-start gap-4 bg-white shrink-0 shadow-sm z-10">
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-serif italic text-2xl tracking-tight text-slate-900 shrink-0">Split-Cycle Ledger</h1>
            
            <nav className="flex items-center bg-slate-100 p-1 rounded-lg">
              <button 
                onClick={() => setActiveView('ledger')}
                className={cn(
                  "flex items-center gap-2 px-4 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-all",
                  activeView === 'ledger' ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-900"
                )}
              >
                <TableIcon className="w-3.5 h-3.5" />
                Ledger
              </button>
              <button 
                onClick={() => setActiveView('dashboard')}
                className={cn(
                  "flex items-center gap-2 px-4 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-all",
                  activeView === 'dashboard' ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-900"
                )}
              >
                <LayoutDashboard className="w-3.5 h-3.5" />
                Dashboard
              </button>
              <button
                onClick={() => setActiveView('creditCards')}
                className={cn(
                  "flex items-center gap-2 px-4 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-all",
                  activeView === 'creditCards' ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-900"
                )}
              >
                <CreditCard className="w-3.5 h-3.5" />
                Cards
              </button>
              <button 
                onClick={() => setActiveView('recurring')}
                className={cn(
                  "flex items-center gap-2 px-4 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-all",
                  activeView === 'recurring' ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-900"
                )}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Recurring
              </button>
              <button
                onClick={() => setActiveView('subscriptions')}
                className={cn(
                  "flex items-center gap-2 px-4 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-all",
                  activeView === 'subscriptions' ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-900"
                )}
              >
                <Repeat2 className="w-3.5 h-3.5" />
                Subscriptions
              </button>
              <button 
                onClick={() => setActiveView('categories')}
                className={cn(
                  "flex items-center gap-2 px-4 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-all",
                  activeView === 'categories' ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-900"
                )}
              >
                <TableIcon className="w-3.5 h-3.5" />
                Categories
              </button>
            </nav>

            <div className="flex items-center gap-1 border border-slate-200 rounded p-0.5 bg-slate-50 shrink-0">
              <button
                onClick={() => setCurrentDate(subMonths(currentDate, 1))}
                className="p-1 hover:bg-slate-200 transition-colors rounded"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="font-mono text-xs font-bold px-3 uppercase tracking-tighter w-24 text-center">
                {format(currentDate, 'MMM yyyy')}
              </span>
              <button
                onClick={() => setCurrentDate(addMonths(currentDate, 1))}
                className="p-1 hover:bg-slate-200 transition-colors rounded"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="grid w-28 shrink-0 grid-cols-1 gap-1">
              <button
                onClick={handleExportCSV}
                className="flex items-center gap-2 px-2 py-1 border border-slate-200 rounded-md text-[9px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-50 hover:text-blue-600 transition-all"
                title="Export Month as CSV"
              >
                <Download className="w-3 h-3 shrink-0" />
                CSV
              </button>
              <button
                onClick={handleExportJSON}
                className="flex items-center gap-2 px-2 py-1 border border-slate-200 rounded-md text-[9px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-50 hover:text-blue-600 transition-all"
                title="Export All Data as JSON Backup"
              >
                <Download className="w-3 h-3 shrink-0" />
                Backup
              </button>
              <button
                onClick={() => importInputRef.current?.click()}
                className="flex items-center gap-2 px-2 py-1 border border-slate-200 rounded-md text-[9px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-50 hover:text-blue-600 transition-all"
                title="Import JSON Backup"
              >
                <Upload className="w-3 h-3 shrink-0" />
                Import
              </button>
            </div>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleImportJSON}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-right shrink-0">
          <div>
            <p className="text-[9px] uppercase tracking-widest opacity-40 font-bold mb-0.5 text-slate-500">Total Income</p>
            <p className="font-mono text-base font-bold text-emerald-600">
              ${formatMoney(totalIncome)}
            </p>
            <MoneyDelta delta={monthComparison.incomeDelta} toneType="credit" label={monthComparison.previousMonthLabel} />
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-widest opacity-40 font-bold mb-0.5 text-slate-500">Total Expenses</p>
            <p className="font-mono text-base font-bold text-rose-600">
              ${formatMoney(totalExpenses)}
            </p>
            <MoneyDelta delta={monthComparison.expensesDelta} toneType="debit" label={monthComparison.previousMonthLabel} />
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-widest opacity-40 font-bold mb-0.5 text-slate-500">Total Net</p>
            <p className="font-mono text-base font-bold text-slate-900">
              ${formatMoney(totalBalance)}
            </p>
            <MoneyDelta delta={monthComparison.balanceDelta} toneType="balance" label={monthComparison.previousMonthLabel} />
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-widest opacity-40 font-bold mb-0.5 text-slate-500">Savings Rate</p>
            <p className={cn(
              "font-mono text-base font-bold",
              totalIncome > 0 ? (savingsRate >= 0.2 ? "text-emerald-600" : "text-blue-600") : "text-slate-400"
            )}>
              {Math.round(savingsRate * 100)}%
            </p>
            <PercentDelta delta={monthComparison.savingsRateDelta} label={monthComparison.previousMonthLabel} />
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="flex-1 overflow-hidden relative">
        {activeView === 'ledger' ? (
          <div className="h-full grid grid-cols-2 gap-0">
            <CyclePane 
              title="Cycle 01 // 1st - 14th" 
              stats={cycles.first} 
              onEdit={editTransaction}
              onDelete={deleteTransaction}
              onTogglePaid={togglePaid}
              comparison={monthComparison}
              subscriptionIds={subscriptionIds}
              headerBg="bg-slate-900"
              headerText="text-white"
            />
            <CyclePane 
              title="Cycle 02 // 15th - End" 
              stats={cycles.second} 
              onEdit={editTransaction}
              onDelete={deleteTransaction}
              onTogglePaid={togglePaid}
              comparison={monthComparison}
              subscriptionIds={subscriptionIds}
              headerBg="bg-slate-100"
              headerText="text-slate-900"
              borderLeft
            />
          </div>
        ) : activeView === 'dashboard' ? (
          <div className="h-full overflow-y-auto p-8 space-y-8 animate-in fade-in duration-500">
            <div className="grid grid-cols-5 gap-6">
              {[
                { label: 'Total Income', val: totalIncome, color: 'text-emerald-600', bg: 'bg-emerald-50' },
                { label: 'Total Expenses', val: totalExpenses, color: 'text-rose-600', bg: 'bg-rose-50' },
                { label: 'Net Cash Flow', val: totalBalance, color: totalBalance >= 0 ? 'text-blue-600' : 'text-rose-700', bg: 'bg-blue-50' },
                { label: 'Monthly Burn', val: totalExpenses / (monthTransactions.length || 1), color: 'text-slate-600', bg: 'bg-slate-100' },
                { label: 'Subscriptions/mo', val: subscriptionMonthlyTotal, color: 'text-violet-600', bg: 'bg-violet-50' }
              ].map((stat, i) => (
                <div key={i} className={cn("p-6 rounded-xl border border-slate-200 bg-white shadow-sm", stat.bg)}>
                  <p className="text-[10px] uppercase font-bold tracking-[0.2em] text-slate-500 mb-2">{stat.label}</p>
                  <p className={cn("font-mono text-2xl font-bold tracking-tighter", stat.color)}>
                    ${stat.val.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-8">
              <div className="col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                <h3 className="text-xs uppercase font-bold tracking-widest text-slate-500 mb-6">Cash Flow Trends (Last 6 Months)</h3>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dashboardData.trendData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                      <XAxis dataKey="name" fontSize={10} axisLine={false} tickLine={false} />
                      <YAxis fontSize={10} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                      <Tooltip 
                        content={<CashFlowTooltip />}
                        cursor={false}
                      />
                      <Legend iconType="circle" wrapperStyle={{ paddingTop: '20px', fontSize: '10px' }} />
                      <Bar dataKey="Income" fill="#10B981" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="Expenses" fill="#EF4444" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                <h3 className="text-xs uppercase font-bold tracking-widest text-slate-500 mb-6">Spending by Category</h3>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={dashboardData.pieData}
                        innerRadius={60}
                        outerRadius={100}
                        paddingAngle={5}
                        dataKey="value"
                      >
                        {dashboardData.pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend layout="horizontal" verticalAlign="bottom" wrapperStyle={{ fontSize: '10px' }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="text-xs uppercase font-bold tracking-widest text-slate-500 mb-6">Month Over Month Balance Trend</h3>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={dashboardData.trendData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                    <XAxis dataKey="name" fontSize={10} axisLine={false} tickLine={false} />
                    <YAxis fontSize={10} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                    <Tooltip />
                    <Line type="monotone" dataKey="Balance" stroke="#2563EB" strokeWidth={3} dot={{ r: 4, fill: '#2563EB' }} activeDot={{ r: 6 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {activeSubscriptions.length > 0 && (
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                <div className="flex items-baseline justify-between mb-6">
                  <h3 className="text-xs uppercase font-bold tracking-widest text-slate-500">
                    Subscription Costs (Monthly Equivalent)
                  </h3>
                  <span className="font-mono text-xs font-bold text-violet-600">
                    ${formatMoney(subscriptionMonthlyTotal)}/mo · ${formatMoney(subscriptionMonthlyTotal * 12)}/yr
                  </span>
                </div>
                <div className="space-y-3">
                  {[...activeSubscriptions]
                    .map(s => ({ sub: s, monthly: getMonthlyEquivalent(s) }))
                    .sort((a, b) => b.monthly - a.monthly)
                    .map(({ sub, monthly }) => {
                      const pct = subscriptionMonthlyTotal > 0 ? (monthly / subscriptionMonthlyTotal) * 100 : 0;
                      return (
                        <div key={sub.id} className="flex items-center gap-3">
                          <span className="w-32 shrink-0 truncate text-xs font-sans font-semibold text-slate-700 flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: sub.color || '#6366F1' }} />
                            {sub.name}
                          </span>
                          <div className="flex-1 h-4 rounded bg-slate-100 overflow-hidden">
                            <div className="h-full rounded" style={{ width: `${pct}%`, backgroundColor: sub.color || '#6366F1' }} />
                          </div>
                          <span className="w-36 shrink-0 text-right font-mono text-xs text-slate-600">
                            ${formatMoney(monthly)}/mo
                            {sub.billingCycle !== 'monthly' && (
                              <span className="text-slate-400"> · ${formatMoney(sub.amount)}/{sub.billingCycle === 'annual' ? 'yr' : sub.billingCycle === 'quarterly' ? 'qtr' : 'wk'}</span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        ) : activeView === 'creditCards' ? (
          <CreditCardsView
            summaries={creditCardSummaries}
            onEdit={(transaction) => {
              setActiveView('ledger');
              editTransaction(transaction);
            }}
            onTogglePaid={togglePaid}
          />
        ) : activeView === 'recurring' ? (
          <div className="h-full overflow-y-auto p-8 animate-in slide-in-from-right duration-500">
             <div className="max-w-4xl mx-auto space-y-6">
               <div className="flex justify-between items-center">
                 <div>
                   <h2 className="font-serif italic text-3xl tracking-tight text-slate-900 border-b-2 border-blue-600 inline-block mb-1">Recurring Master</h2>
                   <p className="text-xs text-slate-500 font-medium">Manage transaction series and auto-projection templates.</p>
                 </div>
               </div>

               <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                 <table className="w-full text-sm border-collapse">
                   <thead className="bg-slate-50 border-b border-slate-200">
                     <tr className="text-left text-[10px] uppercase tracking-widest font-bold text-slate-500">
                       <th className="p-4">Reference Date</th>
                       <th className="p-4">Description</th>
                       <th className="p-4">Category</th>
                       <th className="p-4 text-right">Standard Amount</th>
                       <th className="p-4 text-right">Actions</th>
                     </tr>
                   </thead>
                   <tbody className="font-mono text-xs">
                     {Array.from(new Set(transactions.filter(t => t.isRecurring && t.recurringId).map(t => t.recurringId))).map(rid => {
                       const series = transactions.filter(t => t.recurringId === rid).sort((a,b) => parseISO(b.date).getTime() - parseISO(a.date).getTime());
                       const latest = series[0];
                       const isFromSubscription = !!rid && subscriptionIds.has(rid);
                       return (
                         <tr key={rid} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                           <td className="p-4 text-slate-400">Day {getDate(parseISO(latest.date))}</td>
                           <td className="p-4 font-sans font-bold text-slate-900">
                             <span className="flex items-center gap-2">
                               {latest.description}
                               {isFromSubscription && (
                                 <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-700">
                                   <Repeat2 className="w-2.5 h-2.5" /> Subscription
                                 </span>
                               )}
                             </span>
                           </td>
                           <td className="p-4 font-sans text-slate-500">{latest.category || '--'}</td>
                           <td className={cn("p-4 text-right font-bold", latest.type === 'credit' ? 'text-emerald-600' : 'text-slate-900')}>
                             {latest.type === 'credit' ? '+' : '-'}${latest.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                           </td>
                           <td className="p-4 text-right space-x-2">
                             <button 
                               onClick={() => {
                                 if (isFromSubscription) {
                                   setActiveView('subscriptions');
                                   return;
                                 }
                                 setActiveView('ledger');
                                 editTransaction(latest);
                               }}
                               className="p-1 px-3 border border-slate-200 rounded text-blue-600 hover:bg-blue-50 transition-all font-sans font-bold text-[10px] uppercase"
                             >
                               {isFromSubscription ? 'Manage Sub' : 'Edit Series'}
                             </button>
                             <button 
                               onClick={() => {
                                 if(confirm('Delete entire recurring series and all associated transactions?')) {
                                   deleteTransaction(latest.id, true);
                                 }
                               }}
                               className="p-1 px-3 border border-slate-200 rounded text-rose-600 hover:bg-rose-50 transition-all font-sans font-bold text-[10px] uppercase"
                             >
                               Remove
                             </button>
                           </td>
                         </tr>
                       );
                     })}
                     {transactions.filter(t => t.isRecurring && t.recurringId).length === 0 && (
                       <tr>
                         <td colSpan={5} className="p-12 text-center text-slate-400 italic font-serif">
                           No recurring templates defined yet. Mark an entry as "Recurring" in the ledger to start.
                         </td>
                       </tr>
                     )}
                   </tbody>
                 </table>
               </div>
             </div>
          </div>
        ) : activeView === 'subscriptions' ? (
          <SubscriptionsView
            subscriptions={visibleSubscriptions}
            categories={categories}
            currentDate={currentDate}
            onAdd={addSubscription}
            onUpdate={updateSubscription}
            onDelete={deleteSubscription}
            onStatusChange={changeSubscriptionStatus}
          />
        ) : (
          <div className="h-full overflow-y-auto p-8 animate-in slide-in-from-right duration-500">
            <div className="max-w-3xl mx-auto space-y-6">
              <div>
                <h2 className="font-serif italic text-3xl tracking-tight text-slate-900 border-b-2 border-blue-600 inline-block mb-1">Categories</h2>
                <p className="text-xs text-slate-500 font-medium">Create the category list used by the ledger dropdown.</p>
              </div>

              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
                <div className="flex gap-3 mb-6">
                  <input
                    type="text"
                    value={newCategory}
                    onChange={(event) => setNewCategory(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addCategory();
                      }
                    }}
                    className="flex-1 border border-slate-200 p-2 text-xs outline-none focus:bg-blue-50 focus:border-blue-500 rounded transition-all"
                    placeholder="Mortgage, Utilities, Groceries"
                  />
                  <button
                    type="button"
                    onClick={addCategory}
                    className="flex items-center gap-2 px-4 bg-blue-600 text-white text-[11px] uppercase tracking-widest font-bold py-2.5 hover:bg-blue-700 rounded transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add
                  </button>
                </div>

                <div className="divide-y divide-slate-100 border border-slate-100 rounded-lg overflow-hidden">
                  {categories.length === 0 ? (
                    <div className="p-10 text-center text-slate-400 italic font-serif">
                      Add categories here, then select them when entering bills.
                    </div>
                  ) : (
                    categories.map(categoryOption => (
                      <div key={categoryOption} className="flex items-center justify-between p-3 hover:bg-slate-50 transition-colors">
                        <span className="text-sm font-bold text-slate-800">{categoryOption}</span>
                        <button
                          type="button"
                          onClick={() => deleteCategory(categoryOption)}
                          className="p-1 text-slate-300 hover:text-rose-600 transition-colors"
                          title="Delete category"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Entry Control Panel */}
      <footer className="border-t border-slate-200 p-5 bg-white shrink-0">
        <form onSubmit={handleAddOrUpdate} className="flex flex-col gap-3 max-w-7xl mx-auto">
          <div className="flex items-end gap-5">
          <div className="flex-1 grid grid-cols-8 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">Date</label>
              <input 
                required
                type="date" 
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="border border-slate-200 p-2 text-xs font-mono outline-none focus:bg-blue-50 focus:border-blue-500 rounded transition-all"
              />
            </div>
            <div className="flex flex-col gap-1 col-span-2">
              <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">Description / Payee</label>
              <input 
                required
                type="text" 
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="border border-slate-200 p-2 text-xs outline-none focus:bg-blue-50 focus:border-blue-500 rounded transition-all"
                placeholder="Rent, Grocery, etc"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">Category</label>
              <select 
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="border border-slate-200 p-2 text-xs outline-none focus:bg-blue-50 focus:border-blue-500 rounded bg-white transition-all"
              >
                <option value="">Uncategorized</option>
                {category && !categories.includes(category) && (
                  <option value={category}>{category}</option>
                )}
                {categories.map(categoryOption => (
                  <option key={categoryOption} value={categoryOption}>{categoryOption}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">Type</label>
              <select 
                value={type}
                onChange={(e) => {
                  const nextType = e.target.value as TransactionType;
                  setType(nextType);
                  if (nextType === 'credit') {
                    setPaid(false);
                  }
                }}
                className="border border-slate-200 p-2 text-xs outline-none focus:bg-blue-50 focus:border-blue-500 rounded bg-white font-mono"
              >
                <option value="debit">DEBIT (-)</option>
                <option value="credit">CREDIT (+)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">
                {isCreditCard ? 'Payment' : 'Amount'}
              </label>
              <input 
                required={!isCreditCard}
                type="number" 
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="border border-slate-200 p-2 text-xs font-mono outline-none focus:bg-blue-50 focus:border-blue-500 rounded transition-all"
                placeholder="0.00"
              />
            </div>
            <div className="flex flex-col justify-center items-center gap-1 pb-1">
              <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500 mb-1">Card?</label>
              <button
                type="button"
                onClick={() => {
                  const nextIsCreditCard = !isCreditCard;
                  setIsCreditCard(nextIsCreditCard);
                  if (nextIsCreditCard) {
                    setType('debit');
                    if (!accountName) {
                      setAccountName(description);
                    }
                  }
                }}
                className={cn(
                  "p-2 rounded-md border transition-all",
                  isCreditCard ? "bg-slate-900 border-slate-900 text-white" : "border-slate-200 text-slate-300 hover:border-slate-300"
                )}
                title={isCreditCard ? "Credit card details enabled" : "Track credit card details"}
              >
                <CreditCard className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-col justify-center items-center gap-1 pb-1">
              <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500 mb-1">
                {editingTransaction?.isRecurring ? 'Series' : 'Recurring?'}
              </label>
              {editingTransaction?.isRecurring ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setUpdateSeries(!updateSeries)}
                    className={cn(
                      "p-2 rounded-md border transition-all flex items-center gap-1.5",
                      updateSeries ? "bg-blue-600 border-blue-600 text-white" : "border-slate-200 text-slate-400"
                    )}
                    title={updateSeries ? "Updating all instances in series" : "Update only this instance"}
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5", updateSeries && "animate-[spin_4s_linear_infinite]")} />
                    <span className="text-[10px] font-bold">ALL</span>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsRecurring(!isRecurring)}
                  className={cn(
                    "p-2 rounded-md border transition-all",
                    isRecurring ? "bg-blue-600 border-blue-600 text-white" : "border-slate-200 text-slate-300 hover:border-slate-300"
                  )}
                >
                  <RefreshCw className={cn("w-4 h-4", isRecurring && "animate-[spin_4s_linear_infinite]")} />
                </button>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            {type === 'debit' && (
              <button
                type="button"
                onClick={() => setPaid(!paid)}
                className={cn(
                  "flex items-center gap-2 px-4 border text-[11px] uppercase tracking-widest font-bold py-2.5 rounded transition-colors",
                  paid
                    ? "bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700"
                    : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                )}
                title={paid ? "This bill is marked paid" : "Mark this bill paid"}
              >
                {paid ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5" />}
                Paid
              </button>
            )}
            {editingTransaction && (
              <button 
                type="button" 
                onClick={resetForm}
                className="px-4 bg-slate-100 text-slate-600 border border-slate-200 text-[11px] uppercase tracking-widest font-bold py-2.5 hover:bg-slate-200 rounded transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            )}
            <button 
              type="submit"
              className={cn(
                "px-12 text-white text-[11px] uppercase tracking-widest font-bold py-2.5 transition-all shadow-sm active:translate-y-0.5 rounded",
                editingTransaction ? "bg-blue-700 hover:bg-blue-800" : "bg-blue-600 hover:bg-blue-700"
              )}
            >
              {editingTransaction ? 'Update Entry' : 'Commit Entry'}
            </button>
          </div>
          </div>
          {isCreditCard && (
            <div className="grid grid-cols-8 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-col gap-1 col-span-2">
                <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">Card Name</label>
                <input
                  type="text"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  className="border border-slate-200 p-2 text-xs outline-none focus:bg-blue-50 focus:border-blue-500 rounded transition-all"
                  placeholder="Chase Freedom"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">Current Balance</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentBalance}
                  onChange={(e) => setCurrentBalance(e.target.value)}
                  className="border border-slate-200 p-2 text-xs font-mono outline-none focus:bg-blue-50 focus:border-blue-500 rounded transition-all"
                  placeholder="0.00"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">Minimum</label>
                <input
                  type="number"
                  step="0.01"
                  value={minimumPayment}
                  onChange={(e) => setMinimumPayment(e.target.value)}
                  className="border border-slate-200 p-2 text-xs font-mono outline-none focus:bg-blue-50 focus:border-blue-500 rounded transition-all"
                  placeholder="0.00"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">Due Date</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="border border-slate-200 p-2 text-xs font-mono outline-none focus:bg-blue-50 focus:border-blue-500 rounded transition-all"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">Limit</label>
                <input
                  type="number"
                  step="0.01"
                  value={creditLimit}
                  onChange={(e) => setCreditLimit(e.target.value)}
                  className="border border-slate-200 p-2 text-xs font-mono outline-none focus:bg-blue-50 focus:border-blue-500 rounded transition-all"
                  placeholder="0.00"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">APR %</label>
                <input
                  type="number"
                  step="0.01"
                  value={interestRate}
                  onChange={(e) => setInterestRate(e.target.value)}
                  className="border border-slate-200 p-2 text-xs font-mono outline-none focus:bg-blue-50 focus:border-blue-500 rounded transition-all"
                  placeholder="0.00"
                />
              </div>
              <div className="flex items-end">
                <button
                  type="submit"
                  className={cn(
                    "flex w-full items-center justify-center gap-2 bg-slate-900 text-white text-[11px] uppercase tracking-widest font-bold py-2.5 transition-all shadow-sm active:translate-y-0.5 rounded hover:bg-slate-800",
                    editingTransaction && "bg-blue-700 hover:bg-blue-800"
                  )}
                >
                  <CreditCard className="w-3.5 h-3.5" />
                  {editingTransaction ? 'Update Card' : 'Save Card'}
                </button>
              </div>
            </div>
          )}
        </form>
      </footer>
    </div>
  );
}

function CreditCardsView({
  summaries,
  onEdit,
  onTogglePaid,
}: {
  summaries: CreditCardSummary[];
  onEdit: (transaction: Transaction) => void;
  onTogglePaid: (id: string) => void;
}) {
  const totalCurrentBalance = summaries.reduce((sum, card) => sum + card.currentBalance, 0);
  const totalMinimumPayment = summaries.reduce((sum, card) => sum + card.minimumPayment, 0);
  const totalPlannedPayment = summaries.reduce((sum, card) => sum + card.plannedPayment, 0);
  const totalCreditLimit = summaries.reduce((sum, card) => sum + (card.creditLimit || 0), 0);
  const overallUtilization = totalCreditLimit > 0 ? totalCurrentBalance / totalCreditLimit : null;

  return (
    <div className="h-full overflow-y-auto p-8 animate-in fade-in duration-500">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-end justify-between gap-6">
          <div>
            <h2 className="font-serif italic text-3xl tracking-tight text-slate-900 border-b-2 border-blue-600 inline-block mb-1">Credit Cards</h2>
            <p className="text-xs text-slate-500 font-medium">Track balances, due dates, payment plans, and utilization for this month.</p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4">
          {[
            { label: 'Current Balance', value: totalCurrentBalance, color: 'text-slate-900' },
            { label: 'Minimum Due', value: totalMinimumPayment, color: 'text-rose-600' },
            { label: 'Planned Payments', value: totalPlannedPayment, color: 'text-blue-600' },
            { label: 'Utilization', value: overallUtilization, color: overallUtilization !== null && overallUtilization >= 0.3 ? 'text-rose-600' : 'text-emerald-600', percent: true },
          ].map(stat => (
            <div key={stat.label} className="border border-slate-200 bg-white p-4 rounded-lg shadow-sm">
              <p className="text-[9px] uppercase font-bold tracking-widest text-slate-500 mb-1">{stat.label}</p>
              <p className={cn("font-mono text-xl font-bold tracking-tight", stat.color)}>
                {stat.percent
                  ? stat.value === null ? '--' : `${Math.round((stat.value as number) * 100)}%`
                  : `$${formatMoney(stat.value as number)}`}
              </p>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-[10px] uppercase tracking-widest font-bold text-slate-500">
                <th className="p-4">Card</th>
                <th className="p-4">Due</th>
                <th className="p-4 text-right">Current</th>
                <th className="p-4 text-right">Minimum</th>
                <th className="p-4 text-right">Payment</th>
                <th className="p-4 text-right">Limit</th>
                <th className="p-4 text-right">Util.</th>
                <th className="p-4 text-right">Status</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {summaries.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-12 text-center text-slate-400 italic font-serif">
                    No credit cards tracked for this month. Toggle "Card?" on a ledger entry to add one.
                  </td>
                </tr>
              ) : (
                summaries.map(card => (
                  <tr key={card.key} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                    <td className="p-4">
                      <div className="flex flex-col">
                        <span className="font-sans font-bold text-slate-900">{card.accountName}</span>
                        {card.interestRate !== undefined && (
                          <span className="font-sans text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            {card.interestRate}% APR
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-4 text-slate-500">
                      {card.dueDate ? format(parseISO(card.dueDate), 'MMM d') : '--'}
                    </td>
                    <td className="p-4 text-right font-bold text-slate-900">${formatMoney(card.currentBalance)}</td>
                    <td className="p-4 text-right text-rose-600">${formatMoney(card.minimumPayment)}</td>
                    <td className="p-4 text-right">
                      <div className="flex flex-col items-end">
                        <span className="font-bold text-blue-600">${formatMoney(card.plannedPayment)}</span>
                        <span className="font-sans text-[10px] font-bold uppercase tracking-wider">
                          <PaymentPosture amount={card.plannedPayment} minimumPayment={card.minimumPayment} />
                        </span>
                      </div>
                    </td>
                    <td className="p-4 text-right text-slate-600">
                      {card.creditLimit ? `$${formatMoney(card.creditLimit)}` : '--'}
                    </td>
                    <td className={cn(
                      "p-4 text-right font-bold",
                      card.utilization === null ? "text-slate-400" : card.utilization >= 0.3 ? "text-rose-600" : "text-emerald-600"
                    )}>
                      {card.utilization === null ? '--' : `${Math.round(card.utilization * 100)}%`}
                    </td>
                    <td className="p-4 text-right">
                      <button
                        type="button"
                        onClick={() => onTogglePaid(card.transaction.id)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wider transition-all",
                          card.paid
                            ? "border-emerald-200 bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                            : "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
                        )}
                      >
                        {card.paid ? <CheckCircle2 className="w-3 h-3" /> : <Circle className="w-3 h-3" />}
                        {card.paid ? 'Paid' : 'Unpaid'}
                      </button>
                    </td>
                    <td className="p-4 text-right">
                      <button
                        type="button"
                        onClick={() => onEdit(card.transaction)}
                        className="p-1 px-3 border border-slate-200 rounded text-blue-600 hover:bg-blue-50 transition-all font-sans font-bold text-[10px] uppercase"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CyclePane({ 
  title, 
  stats, 
  onEdit, 
  onDelete, 
  onTogglePaid,
  comparison,
  subscriptionIds,
  headerBg, 
  headerText,
  borderLeft = false
}: { 
  title: string; 
  stats: any; 
  onEdit: (t: Transaction) => void;
  onDelete: (id: string, cascade?: boolean) => void;
  onTogglePaid: (id: string) => void;
  comparison: MonthComparison;
  subscriptionIds: Set<string>;
  headerBg: string;
  headerText: string;
  borderLeft?: boolean;
}) {
  return (
    <section className={cn("flex flex-col h-full overflow-hidden", borderLeft && "border-l border-slate-200")}>
      <div className={cn("p-4 flex justify-between items-center shrink-0 border-b border-slate-900", headerBg, headerText)}>
        <h2 className="text-xs uppercase tracking-[0.3em] font-bold">{title}</h2>
        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end">
             <span className="text-[8px] uppercase tracking-widest opacity-60 font-bold">Bills</span>
             <span className="font-mono text-xs opacity-70">
               ${formatMoney(stats.expenses)}
             </span>
          </div>
          <div className="flex flex-col items-end">
             <span className="text-[8px] uppercase tracking-widest opacity-60 font-bold">Delta</span>
             <span className="font-mono text-sm font-bold">
               ${formatMoney(stats.balance)}
             </span>
          </div>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-slate-50 z-[5]">
            <tr className="border-b border-slate-200 text-left opacity-60 font-serif italic text-slate-500">
              <th className="p-3 font-normal">Date</th>
              <th className="p-3 font-normal">Description</th>
              <th className="p-3 font-normal">Category</th>
              <th className="p-3 font-normal">Status</th>
              <th className="p-3 font-normal text-right">Amount</th>
              <th className="p-3 font-normal text-right w-20">Actions</th>
            </tr>
          </thead>
          <tbody className="font-mono text-slate-700">
            {stats.transactions.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-12 text-center text-gray-400 italic font-serif">
                  No records found for this period.
                </td>
              </tr>
            ) : (
              stats.transactions
                .sort((a: any, b: any) => parseISO(a.date).getTime() - parseISO(b.date).getTime())
                .map((t: Transaction) => {
                  const itemComparison = comparison.transactions[t.id];
                  return (
                    <tr
                      key={t.id}
                      className={cn(
                        "border-b border-slate-100 group hover:bg-blue-50/50 transition-colors",
                        t.type === 'credit' && "bg-emerald-50/30",
                        t.type === 'debit' && t.paid && "bg-emerald-50/40"
                      )}
                    >
                      <td className="p-3 border-r border-slate-100 w-16">
                        <div className="flex items-center gap-1">
                          {t.isRecurring && (
                            t.recurringId && subscriptionIds.has(t.recurringId)
                              ? <Repeat2 className="w-2.5 h-2.5 text-violet-500 shrink-0" />
                              : <RefreshCw className="w-2.5 h-2.5 text-blue-500 shrink-0" />
                          )}
                          {format(parseISO(t.date), 'MM-dd')}
                        </div>
                      </td>
                      <td className="p-3 border-r border-slate-100 text-slate-800 font-medium">
                        <span className="truncate block max-w-[150px]">{t.description}</span>
                        {isCreditCardTransaction(t) && (
                          <span className="mt-1 block max-w-[260px] truncate font-sans text-[10px] font-semibold text-slate-500">
                            {t.accountName || t.description}
                            {typeof t.currentBalance === 'number' && ` • Bal $${formatMoney(t.currentBalance)}`}
                            {typeof t.minimumPayment === 'number' && ` • Min $${formatMoney(t.minimumPayment)}`}
                            {t.dueDate && ` • Due ${format(parseISO(t.dueDate), 'MMM d')}`}
                          </span>
                        )}
                      </td>
                      <td className="p-3 border-r border-slate-100 text-slate-500">
                        <span className="truncate block max-w-[100px]">{t.category || '--'}</span>
                      </td>
                      <td className="p-3 border-r border-slate-100">
                        {t.type === 'debit' ? (
                          <button
                            type="button"
                            onClick={() => onTogglePaid(t.id)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wider transition-all",
                              t.paid
                                ? "border-emerald-200 bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                                : "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
                            )}
                            title={t.paid ? "Mark this bill unpaid" : "Mark this bill paid"}
                          >
                            {t.paid ? <CheckCircle2 className="w-3 h-3" /> : <Circle className="w-3 h-3" />}
                            {t.paid ? 'Paid' : 'Unpaid'}
                          </button>
                        ) : (
                          <span className="inline-flex items-center rounded-full border border-emerald-100 bg-emerald-50 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-emerald-700">
                            Income
                          </span>
                        )}
                      </td>
                      <td className={cn(
                        "p-3 text-right border-r border-slate-100",
                        t.type === 'credit' ? "text-emerald-600 font-bold" : "text-slate-900"
                      )}>
                        <div className="flex flex-col items-end gap-0.5">
                          <span>{t.type === 'credit' ? '+' : '-'}{formatMoney(t.amount)}</span>
                          {itemComparison?.delta === null ? (
                            <span className="font-sans text-[9px] font-bold uppercase tracking-wider text-slate-400">
                              New vs {comparison.previousMonthLabel}
                            </span>
                          ) : itemComparison ? (
                            <MoneyDelta
                              delta={itemComparison.delta}
                              toneType={t.type}
                              label={comparison.previousMonthLabel}
                            />
                          ) : null}
                          {isCreditCardTransaction(t) && (
                            <span className="font-sans text-[9px] font-bold uppercase tracking-wider">
                              <PaymentPosture amount={t.amount} minimumPayment={t.minimumPayment} />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-3 text-right">
                        <div className="flex justify-end gap-1 opacity-10 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => onEdit(t)}
                            className="p-1 hover:text-blue-600 transition-colors"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onDelete(t.id)}
                            className="p-1 hover:text-rose-600 transition-colors"
                            title="Delete instance"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                          {t.isRecurring && (
                            <button
                              onClick={() => {
                                if(confirm('Delete entire recurring series? (All historical and future entries for this item will be removed)')) {
                                  onDelete(t.id, true);
                                }
                              }}
                              className="p-1 hover:text-rose-900 transition-colors"
                              title="Delete entire series"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const SUBSCRIPTION_COLORS = ['#2563EB', '#7C3AED', '#DB2777', '#EA580C', '#F59E0B', '#10B981', '#06B6D4', '#6366F1'];

const BILLING_CYCLE_LABELS: Record<BillingCycle, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
};

const BILLING_CYCLE_SUFFIX: Record<BillingCycle, string> = {
  weekly: 'wk',
  monthly: 'mo',
  quarterly: 'qtr',
  annual: 'yr',
};

type SubscriptionFormState = {
  name: string;
  amount: string;
  billingCycle: BillingCycle;
  billingDay: string;
  category: string;
  status: SubscriptionStatus;
  startDate: string;
  trialEndDate: string;
  autoCreateTransaction: boolean;
  url: string;
  notes: string;
  color: string;
};

const emptySubscriptionForm = (): SubscriptionFormState => ({
  name: '',
  amount: '',
  billingCycle: 'monthly',
  billingDay: '1',
  category: '',
  status: 'active',
  startDate: format(new Date(), 'yyyy-MM-dd'),
  trialEndDate: '',
  autoCreateTransaction: true,
  url: '',
  notes: '',
  color: SUBSCRIPTION_COLORS[0],
});

function SubscriptionsView({
  subscriptions,
  categories,
  currentDate,
  onAdd,
  onUpdate,
  onDelete,
  onStatusChange,
}: {
  subscriptions: Subscription[];
  categories: string[];
  currentDate: Date;
  onAdd: (input: SubscriptionInput) => void;
  onUpdate: (id: string, changes: Partial<Subscription>) => void;
  onDelete: (id: string, deleteTransactions?: boolean) => void;
  onStatusChange: (id: string, status: SubscriptionStatus) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SubscriptionFormState>(emptySubscriptionForm);

  const setField = <K extends keyof SubscriptionFormState>(key: K, value: SubscriptionFormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const resetForm = () => {
    setForm(emptySubscriptionForm());
    setEditingId(null);
    setShowForm(false);
  };

  const startEdit = (sub: Subscription) => {
    setEditingId(sub.id);
    setForm({
      name: sub.name,
      amount: sub.amount.toString(),
      billingCycle: sub.billingCycle,
      billingDay: sub.billingDay.toString(),
      category: sub.category || '',
      status: sub.status,
      startDate: sub.startDate ? sub.startDate.slice(0, 10) : format(new Date(), 'yyyy-MM-dd'),
      trialEndDate: sub.trialEndDate ? sub.trialEndDate.slice(0, 10) : '',
      autoCreateTransaction: sub.autoCreateTransaction,
      url: sub.url || '',
      notes: sub.notes || '',
      color: sub.color || SUBSCRIPTION_COLORS[0],
    });
    setShowForm(true);
  };

  const handleSubmit = () => {
    const name = form.name.trim();
    const amount = parseFloat(form.amount);
    if (!name || !Number.isFinite(amount)) return;

    const billingDay = Math.min(Math.max(Math.round(parseInt(form.billingDay, 10) || 1), 1), 28);

    const payload: SubscriptionInput = {
      name,
      amount,
      billingCycle: form.billingCycle,
      billingDay,
      category: form.category || undefined,
      status: form.status,
      startDate: form.startDate,
      trialEndDate: form.trialEndDate || undefined,
      autoCreateTransaction: form.autoCreateTransaction,
      url: form.url.trim() || undefined,
      notes: form.notes.trim() || undefined,
      color: form.color,
    };

    if (editingId) {
      onUpdate(editingId, payload);
    } else {
      onAdd(payload);
    }
    resetForm();
  };

  const monthlyTotal = subscriptions
    .filter(s => s.status === 'active')
    .reduce((sum, s) => sum + getMonthlyEquivalent(s), 0);
  const activeCount = subscriptions.filter(s => s.status === 'active').length;
  const pausedCount = subscriptions.filter(s => s.status === 'paused').length;
  const cancelledCount = subscriptions.filter(s => s.status === 'cancelled').length;

  const today = new Date();

  const statusPill = (status: SubscriptionStatus) => {
    const styles: Record<SubscriptionStatus, string> = {
      active: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      paused: 'border-amber-200 bg-amber-50 text-amber-700',
      cancelled: 'border-rose-200 bg-rose-50 text-rose-700',
    };
    return (
      <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider', styles[status])}>
        {status}
      </span>
    );
  };

  const summary = [
    { label: 'Monthly Cost', value: `$${formatMoney(monthlyTotal)}`, color: 'text-violet-600', bg: 'bg-violet-50' },
    { label: 'Annual Exposure', value: `$${formatMoney(monthlyTotal * 12)}`, color: 'text-blue-600', bg: 'bg-blue-50' },
    { label: 'Active', value: activeCount.toString(), color: 'text-emerald-600', bg: 'bg-emerald-50' },
    { label: 'Paused / Cancelled', value: `${pausedCount} / ${cancelledCount}`, color: 'text-slate-600', bg: 'bg-slate-100' },
  ];

  return (
    <div className="h-full overflow-y-auto p-8 animate-in slide-in-from-right duration-500">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="font-serif italic text-3xl tracking-tight text-slate-900 border-b-2 border-blue-600 inline-block mb-1">Subscriptions</h2>
            <p className="text-xs text-slate-500 font-medium">Track recurring services and auto-post their charges to the ledger.</p>
          </div>
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-2 px-4 bg-blue-600 text-white text-[11px] uppercase tracking-widest font-bold py-2.5 hover:bg-blue-700 rounded transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> New Subscription
          </button>
        </div>

        <div className="grid grid-cols-4 gap-6">
          {summary.map((card, i) => (
            <div key={i} className={cn('p-6 rounded-xl border border-slate-200 bg-white shadow-sm', card.bg)}>
              <p className="text-[10px] uppercase font-bold tracking-[0.2em] text-slate-500 mb-2">{card.label}</p>
              <p className={cn('font-mono text-2xl font-bold tracking-tighter', card.color)}>{card.value}</p>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-[10px] uppercase tracking-widest font-bold text-slate-500">
                <th className="p-4">Service</th>
                <th className="p-4">Category</th>
                <th className="p-4 text-right">Amount</th>
                <th className="p-4">Cycle</th>
                <th className="p-4">Next Charge</th>
                <th className="p-4">Status</th>
                <th className="p-4 text-center">Auto-Ledger</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="text-xs">
              {subscriptions.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-12 text-center text-slate-400 italic font-serif">
                    No subscriptions yet. Add one to start tracking recurring spend.
                  </td>
                </tr>
              )}
              {[...subscriptions]
                .sort((a, b) => getMonthlyEquivalent(b) - getMonthlyEquivalent(a))
                .map(sub => {
                  const isTrial = !!sub.trialEndDate && parseISO(sub.trialEndDate) > today;
                  return (
                    <tr key={sub.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                      <td className="p-4">
                        <div className="flex items-center gap-2 font-sans font-bold text-slate-900">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: sub.color || '#6366F1' }} />
                          {sub.name}
                          {sub.url && (
                            <a href={sub.url} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-blue-600" title="Manage subscription">
                              <Globe className="w-3 h-3" />
                            </a>
                          )}
                          {isTrial && (
                            <span className="inline-flex items-center rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-cyan-700">Trial</span>
                          )}
                        </div>
                      </td>
                      <td className="p-4 font-sans text-slate-500">{sub.category || '--'}</td>
                      <td className="p-4 text-right font-mono">
                        <div className="font-bold text-slate-900">${formatMoney(getMonthlyEquivalent(sub))}<span className="text-slate-400 font-normal">/mo</span></div>
                        {sub.billingCycle !== 'monthly' && (
                          <div className="text-[10px] text-slate-400">${formatMoney(sub.amount)}/{BILLING_CYCLE_SUFFIX[sub.billingCycle]}</div>
                        )}
                      </td>
                      <td className="p-4 font-sans text-slate-600">{BILLING_CYCLE_LABELS[sub.billingCycle]}</td>
                      <td className="p-4 font-mono text-slate-600">
                        {sub.status === 'active' ? format(parseISO(getNextBillingDate(sub, currentDate)), 'MMM d') : '--'}
                      </td>
                      <td className="p-4">{statusPill(sub.status)}</td>
                      <td className="p-4 text-center">
                        {sub.autoCreateTransaction
                          ? <CheckCircle2 className="w-4 h-4 text-emerald-500 inline" />
                          : <Circle className="w-4 h-4 text-slate-300 inline" />}
                      </td>
                      <td className="p-4">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => startEdit(sub)} className="p-1.5 text-slate-500 hover:text-blue-600 transition-colors" title="Edit">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          {sub.status === 'active' ? (
                            <button onClick={() => onStatusChange(sub.id, 'paused')} className="p-1.5 text-slate-500 hover:text-amber-600 transition-colors" title="Pause">
                              <Pause className="w-3.5 h-3.5" />
                            </button>
                          ) : sub.status === 'paused' ? (
                            <button onClick={() => onStatusChange(sub.id, 'active')} className="p-1.5 text-slate-500 hover:text-emerald-600 transition-colors" title="Resume">
                              <Play className="w-3.5 h-3.5" />
                            </button>
                          ) : null}
                          {sub.status !== 'cancelled' && (
                            <button onClick={() => onStatusChange(sub.id, 'cancelled')} className="p-1.5 text-slate-500 hover:text-rose-600 transition-colors" title="Cancel">
                              <Ban className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => {
                              const cascade = confirm(
                                `Delete "${sub.name}"?\n\nOK = also remove its ledger transactions.\nCancel = keep this subscription.`
                              );
                              if (cascade) onDelete(sub.id, true);
                            }}
                            className="p-1.5 text-slate-500 hover:text-rose-900 transition-colors"
                            title="Delete subscription"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        {showForm && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-xs uppercase font-bold tracking-widest text-slate-500">
                {editingId ? 'Edit Subscription' : 'New Subscription'}
              </h3>
              <button onClick={resetForm} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <label className="flex flex-col gap-1 col-span-2 md:col-span-1">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Name *</span>
                <input value={form.name} onChange={e => setField('name', e.target.value)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500" placeholder="Netflix" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Amount *</span>
                <input type="number" step="0.01" value={form.amount} onChange={e => setField('amount', e.target.value)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500" placeholder="15.49" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Billing Cycle</span>
                <select value={form.billingCycle} onChange={e => setField('billingCycle', e.target.value as BillingCycle)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500">
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annual">Annual</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Billing Day (1–28)</span>
                <input type="number" min={1} max={28} value={form.billingDay} onChange={e => setField('billingDay', e.target.value)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Category</span>
                <select value={form.category} onChange={e => setField('category', e.target.value)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500">
                  <option value="">--</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Status</span>
                <select value={form.status} onChange={e => setField('status', e.target.value as SubscriptionStatus)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500">
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Start Date</span>
                <input type="date" value={form.startDate} onChange={e => setField('startDate', e.target.value)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Trial Ends (optional)</span>
                <input type="date" value={form.trialEndDate} onChange={e => setField('trialEndDate', e.target.value)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500" />
              </label>
              <label className="flex flex-col gap-1 col-span-2 md:col-span-1">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Manage URL (optional)</span>
                <input value={form.url} onChange={e => setField('url', e.target.value)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500" placeholder="https://..." />
              </label>
              <label className="flex flex-col gap-1 col-span-2 md:col-span-3">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Notes (optional)</span>
                <input value={form.notes} onChange={e => setField('notes', e.target.value)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500" />
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
              <div className="flex items-center gap-3">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Color</span>
                <div className="flex gap-1.5">
                  {SUBSCRIPTION_COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setField('color', c)}
                      className={cn('w-5 h-5 rounded-full border-2 transition-transform', form.color === c ? 'border-slate-900 scale-110' : 'border-transparent')}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setField('autoCreateTransaction', !form.autoCreateTransaction)}
                  className={cn('w-9 h-5 rounded-full transition-colors relative', form.autoCreateTransaction ? 'bg-blue-600' : 'bg-slate-300')}
                >
                  <span className={cn('absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all', form.autoCreateTransaction ? 'left-[18px]' : 'left-0.5')} />
                </button>
                <span className="text-[11px] font-semibold text-slate-600">Auto-post charges to ledger</span>
              </label>
            </div>

            {form.billingDay && parseInt(form.billingDay, 10) > 28 && (
              <p className="text-[10px] text-amber-600 font-semibold">Days 29–31 aren't supported — use 28 to approximate month-end billing.</p>
            )}

            <div className="flex gap-3 pt-2">
              <button onClick={handleSubmit} className="px-5 bg-blue-600 text-white text-[11px] uppercase tracking-widest font-bold py-2.5 hover:bg-blue-700 rounded transition-colors">
                {editingId ? 'Save Changes' : 'Add Subscription'}
              </button>
              <button onClick={resetForm} className="px-5 border border-slate-200 text-slate-600 text-[11px] uppercase tracking-widest font-bold py-2.5 hover:bg-slate-50 rounded transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
