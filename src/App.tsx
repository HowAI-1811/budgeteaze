/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect, useRef, type ChangeEvent, type FormEvent } from 'react';
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
  CreditCard as CreditCardIcon,
  Repeat2,
  Globe,
  Pause,
  Play,
  Ban,
  AlertTriangle,
  Wallet
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
import { Transaction, TransactionType, Subscription, SubscriptionStatus, BillingCycle, CreditCard, CardTransaction, CardNetwork } from './types';
import { auth } from './lib/firebase';
import { loadFromCloud, saveToCloud, saveToCloudDebounced, BudgetData } from './lib/sync';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { Cloud, CloudOff, Loader2 } from 'lucide-react';
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
import {
  loadCreditCards,
  saveCreditCards,
  loadCardTransactions,
  saveCardTransactions,
  createCreditCard,
  touchCreditCard,
  tombstoneCreditCard,
  createCardTransaction,
  isLive,
  getUtilization,
  getAvailableCredit,
  getDaysUntilDue,
  sanitizeCreditCard,
  sanitizeCardTransaction,
  type CreditCardInput,
  type CardTransactionInput,
} from './lib/creditCards';

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

const normalizeMatchPart = (value?: string) => value?.trim().toLowerCase() || 'uncategorized';

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

type MigratedBackup = {
  creditCards: unknown[];
  cardTransactions: unknown[];
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Normalize a backup to the current shape regardless of its `version`.
 * Non-destructive: v1 (transactions only) and v2 (adds subscriptions) simply
 * yield empty credit-card arrays. v3+ carries the card entities through.
 */
const migrateBackup = (backup: unknown): MigratedBackup => {
  const b = (backup && typeof backup === 'object' ? backup : {}) as Record<string, unknown>;
  return {
    creditCards: asArray(b.creditCards),
    cardTransactions: asArray(b.cardTransactions),
  };
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

  // Credit card entities (raw lists include tombstones).
  const [creditCards, setCreditCards] = useState<CreditCard[]>(() => loadCreditCards());
  const [cardTransactions, setCardTransactions] = useState<CardTransaction[]>(() => loadCardTransactions());

  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [syncStatus, setSyncStatus] = useState<'offline' | 'synced' | 'syncing' | 'error'>('offline');
  const [showSyncModal, setShowSyncModal] = useState(false);
  // Auth Form states
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);

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
  const importInputRef = useRef<HTMLInputElement>(null);

  // ── Sync Integration ───────────────────────────────────────────────────────
  // true while sign-in or session-restore sync is in progress — blocks auto-sync
  const isInitialLoad = useRef(true);
  // true after downloading from cloud — skips one auto-sync run to avoid re-upload
  const justSyncedFromCloud = useRef(false);

  // Restore a previously-signed-in session on app load
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user && user.isAnonymous) {
        // Legacy anonymous session — clear it out
        await signOut(auth);
        return; // onAuthStateChanged will fire again with user=null
      }
      if (user && isInitialLoad.current) {
        // Persisted email login: restore session and run conflict resolution
        setCurrentUser(user);
        setSyncStatus('syncing');
        try {
          const cloudData = await loadFromCloud(user.uid);
          const localTimestamp = localStorage.getItem('cyclebudget_last_updated') || '';
          if (cloudData && cloudData.updatedAt && cloudData.updatedAt > localTimestamp) {
            // Cloud is newer — download it
            justSyncedFromCloud.current = true;
            setTransactions(cloudData.transactions || []);
            setCategories(cloudData.categories || []);
            setSubscriptions(cloudData.subscriptions || []);
            setCreditCards(cloudData.creditCards || []);
            setCardTransactions(cloudData.cardTransactions || []);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cloudData.transactions || []));
            localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(cloudData.categories || []));
            saveSubscriptions(cloudData.subscriptions || []);
            saveCreditCards(cloudData.creditCards || []);
            saveCardTransactions(cloudData.cardTransactions || []);
            localStorage.setItem('cyclebudget_last_updated', cloudData.updatedAt);
          }
          // If local is newer: auto-sync will push it once isInitialLoad is false
          setSyncStatus('synced');
        } catch (err) {
          console.error('Session restore sync failed:', err);
          setSyncStatus('error');
        } finally {
          isInitialLoad.current = false;
        }
      } else if (!user) {
        // No session or signed out
        setCurrentUser(null);
        setSyncStatus('offline');
        isInitialLoad.current = true;
      }
    });
    return () => unsubscribe();
  }, []);

  // Auto-sync: fires when data changes while signed in
  useEffect(() => {
    if (isInitialLoad.current) return;
    if (!currentUser) return;

    // Skip one run after downloading from cloud to avoid immediately re-uploading
    if (justSyncedFromCloud.current) {
      justSyncedFromCloud.current = false;
      return;
    }

    // Save locally
    const timestamp = new Date().toISOString();
    localStorage.setItem('cyclebudget_last_updated', timestamp);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
    localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(categories));
    saveSubscriptions(subscriptions);
    saveCreditCards(creditCards);
    saveCardTransactions(cardTransactions);

    // Sync to Firebase (debounced)
    saveToCloudDebounced(
      currentUser.uid,
      { transactions, categories, subscriptions, creditCards, cardTransactions },
      setSyncStatus
    );
  }, [transactions, categories, subscriptions, creditCards, cardTransactions, currentUser]);

  // Live (non-tombstoned) credit card entities for the dashboard.
  const visibleCreditCards = useMemo(
    () => creditCards.filter(isLive),
    [creditCards],
  );
  const visibleCardTransactions = useMemo(
    () => cardTransactions.filter(isLive),
    [cardTransactions],
  );

  // ── Credit card mutations ─────────────────────────────────────────────────
  const addCreditCard = (input: CreditCardInput) => {
    setCreditCards(prev => [...prev, createCreditCard(input)]);
  };
  const updateCreditCard = (id: string, changes: Partial<CreditCard>) => {
    setCreditCards(prev =>
      prev.map(c => (c.id === id ? touchCreditCard(c, changes) : c)),
    );
  };
  const deleteCreditCard = (id: string) => {
    setCreditCards(prev =>
      prev.map(c => (c.id === id ? tombstoneCreditCard(c) : c)),
    );
  };
  const addCardTransaction = (input: CardTransactionInput) => {
    setCardTransactions(prev => [...prev, createCardTransaction(input)]);
  };
  // Records a payment: reduces the card balance and logs a negative charge.
  // Subscriptions charged to this card are already sitting in the ledger
  // (see the injection effect below), so paying them isn't a new expense.
  // But a card statement usually also covers other, un-itemized charges
  // (groceries, gas, one-off purchases) that were never logged individually.
  // Whatever the payment covers beyond the subscriptions already recorded
  // this month gets added as one lump-sum ledger expense, so Total Expenses
  // still reflects real spending instead of silently under-counting it.
  const logCardPayment = (cardId: string, amount: number, date: string, item?: string) => {
    addCardTransaction({
      cardId,
      description: 'Payment',
      amount: -Math.abs(amount),
      date,
      category: 'Payment',
      posted: true,
    });
    setCreditCards(prev =>
      prev.map(c =>
        c.id === cardId
          ? touchCreditCard(c, { balance: Math.max(c.balance - Math.abs(amount), 0) })
          : c,
      ),
    );

    const paymentMonth = date.slice(0, 7);
    // Build the subscription→card map inline so we don't rely on the
    // subscriptionCardById useMemo, which is declared later in the component
    // body and would be undefined if referenced via closure here.
    const subCardMap = new Map<string, string>();
    subscriptions.forEach(s => {
      if (!s.cardId) return;
      const card = creditCards.find(c => c.id === s.cardId);
      if (card) subCardMap.set(s.id, card.id);
    });
    const subscriptionChargesThisMonth = transactions
      .filter(t => t.date.startsWith(paymentMonth) && t.recurringId && subCardMap.get(t.recurringId) === cardId)
      .reduce((sum, t) => sum + t.amount, 0);
    const otherCharges = Math.abs(amount) - subscriptionChargesThisMonth;

    if (otherCharges > 0.005) {
      const card = creditCards.find(c => c.id === cardId);
      setTransactions(prev => [...prev, {
        id: crypto.randomUUID(),
        description: item || `${card?.name || 'Card'} — other charges`,
        amount: otherCharges,
        type: 'debit',
        date,
        category: 'Credit Card',
        paid: true,
        notes: 'Auto-added from Log Payment — covers charges on this statement not already itemized in the ledger.',
      }]);
    }
  };

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

  // Card-linked subscriptions are settled when the card's own bill is paid —
  // they shouldn't surface as separately-payable line items in the ledger.
  // Maps subscription id -> the CreditCard it's charged to.
  const subscriptionCardById = useMemo(() => {
    const map = new Map<string, CreditCard>();
    subscriptions.forEach(s => {
      if (!s.cardId) return;
      const card = creditCards.find(c => c.id === s.cardId);
      if (card) map.set(s.id, card);
    });
    return map;
  }, [subscriptions, creditCards]);

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
          // Card-linked subscriptions are settled by the card's own bill
          // payment, not individually — mark them paid on arrival so they
          // don't nag as an outstanding bill in the ledger.
          paid: !!sub.cardId,
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
    const transactionDescription = description.trim();
    const parsedAmount = amount.trim() ? parseFloat(amount) : 0;
    if (!transactionDescription || !amount.trim() || !Number.isFinite(parsedAmount)) return;

    const recurringId = editingTransaction?.recurringId || (isRecurring ? crypto.randomUUID() : undefined);

    const newTransaction: Transaction = {
      id: editingTransaction?.id || crypto.randomUUID(),
      description: transactionDescription,
      amount: parsedAmount,
      category,
      type,
      date,
      isRecurring,
      recurringId,
      paid,
      notes,
    };

    if (editingTransaction) {
      if (updateSeries && recurringId) {
        // Update all historical and future instances of this recurring series
        setTransactions(prev => prev.map(t => {
          if (t.recurringId === recurringId) {
            return {
              ...t,
              description: transactionDescription,
              amount: parsedAmount,
              category,
              type,
              notes,
              isRecurring: true, // Keep it recurring
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
      version: 3,
      exportedAt: new Date().toISOString(),
      categories,
      subscriptions,
      transactions,
      creditCards,
      cardTransactions,
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

      // Credit card entities arrive in v3+ backups. migrateBackup() back-fills
      // them as empty for older (v1/v2) files; a single bad record is skipped
      // rather than rejecting the whole file.
      const migrated = migrateBackup(backup);
      const importedCreditCards: CreditCard[] = [];
      for (const item of migrated.creditCards) {
        const card = sanitizeCreditCard(item);
        if (card) importedCreditCards.push(card);
      }
      const importedCardTransactions: CardTransaction[] = [];
      for (const item of migrated.cardTransactions) {
        const txn = sanitizeCardTransaction(item);
        if (txn) importedCardTransactions.push(txn);
      }

      const shouldReplace = confirm(
        `Import ${importedTransactions.length} transactions, ${importedCategories.length} categories, ${importedSubscriptions.length} subscriptions, and ${importedCreditCards.length} credit cards?\nThis will replace your current saved data.`
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
        setCreditCards(importedCreditCards);
        setCardTransactions(importedCardTransactions);
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

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setIsAuthSubmitting(true);
    isInitialLoad.current = true; // block auto-sync while we do conflict resolution

    try {
      const userCredential = await signInWithEmailAndPassword(auth, authEmail, authPassword);
      const user = userCredential.user;
      setCurrentUser(user);
      setSyncStatus('syncing');

      const cloudData = await loadFromCloud(user.uid);
      const localTimestamp = localStorage.getItem('cyclebudget_last_updated') || '';

      if (cloudData && cloudData.updatedAt && cloudData.updatedAt > localTimestamp) {
        // Cloud is newer — load it
        justSyncedFromCloud.current = true;
        setTransactions(cloudData.transactions || []);
        setCategories(cloudData.categories || []);
        setSubscriptions(cloudData.subscriptions || []);
        setCreditCards(cloudData.creditCards || []);
        setCardTransactions(cloudData.cardTransactions || []);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cloudData.transactions || []));
        localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(cloudData.categories || []));
        saveSubscriptions(cloudData.subscriptions || []);
        saveCreditCards(cloudData.creditCards || []);
        saveCardTransactions(cloudData.cardTransactions || []);
        localStorage.setItem('cyclebudget_last_updated', cloudData.updatedAt);
      } else {
        // Local is newer or no cloud data — upload local budget to this account
        await saveToCloud(user.uid, {
          transactions,
          categories,
          subscriptions,
          creditCards,
          cardTransactions
        });
      }

      setSyncStatus('synced');
      setShowSyncModal(false);
      setAuthEmail('');
      setAuthPassword('');
    } catch (err: any) {
      console.error('Sign-in error:', err);
      if (err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
        setAuthError('Invalid email or password.');
      } else if (err.code === 'auth/too-many-requests') {
        setAuthError('Too many attempts. Please wait a moment and try again.');
      } else {
        setAuthError(err.message || 'Sign-in failed. Please try again.');
      }
    } finally {
      isInitialLoad.current = false;
      setIsAuthSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    if (confirm("Sign out? Your budget stays saved on this device.")) {
      try {
        await signOut(auth);
        // onAuthStateChanged will fire and set currentUser=null, syncStatus='offline'
        setShowSyncModal(false);
      } catch (err) {
        console.error('Sign out error:', err);
      }
    }
  };

  const forceUploadToCloud = async () => {
    if (!currentUser) return;
    if (confirm("Are you sure you want to overwrite cloud data with your current local data? This cannot be undone.")) {
      setSyncStatus('syncing');
      try {
        const localData: BudgetData = {
          transactions,
          categories,
          subscriptions,
          creditCards,
          cardTransactions
        };
        await saveToCloud(currentUser.uid, localData);
        setSyncStatus('synced');
        alert("✓ Cloud data successfully updated with local budget.");
      } catch (err) {
        console.error('Force upload failed:', err);
        setSyncStatus('error');
      }
    }
  };

  const forceDownloadFromCloud = async () => {
    if (!currentUser) return;
    if (confirm("Are you sure you want to download data from the cloud? This will overwrite ALL your current local data with the remote copy.")) {
      setSyncStatus('syncing');
      try {
        const cloudData = await loadFromCloud(currentUser.uid);
        if (cloudData) {
          setTransactions(cloudData.transactions || []);
          setCategories(cloudData.categories || []);
          setSubscriptions(cloudData.subscriptions || []);
          setCreditCards(cloudData.creditCards || []);
          setCardTransactions(cloudData.cardTransactions || []);
          
          localStorage.setItem(STORAGE_KEY, JSON.stringify(cloudData.transactions || []));
          localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(cloudData.categories || []));
          saveSubscriptions(cloudData.subscriptions || []);
          saveCreditCards(cloudData.creditCards || []);
          saveCardTransactions(cloudData.cardTransactions || []);
          localStorage.setItem('cyclebudget_last_updated', cloudData.updatedAt || '');
          setSyncStatus('synced');
          alert("✓ Local budget successfully updated with cloud data.");
        } else {
          alert("No data found in the cloud for this account.");
          setSyncStatus('synced');
        }
      } catch (err) {
        console.error('Force download failed:', err);
        setSyncStatus('error');
      }
    }
  };

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
                <CreditCardIcon className="w-3.5 h-3.5" />
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

            <button
              onClick={() => setShowSyncModal(true)}
              className={cn(
                "flex items-center gap-2 px-2 py-2.5 border rounded-md text-[9px] font-bold uppercase tracking-wider transition-all shadow-sm shrink-0 w-28 justify-center",
                syncStatus === 'synced' ? "bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100" :
                syncStatus === 'syncing' ? "bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100" :
                syncStatus === 'error' ? "bg-rose-50 border-rose-200 text-rose-700 hover:bg-rose-100" :
                "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
              )}
              title="Cloud Sync"
            >
              {syncStatus === 'synced' && <Cloud className="w-3.5 h-3.5" />}
              {syncStatus === 'syncing' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {syncStatus === 'error' && <CloudOff className="w-3.5 h-3.5" />}
              {syncStatus === 'offline' && <CloudOff className="w-3.5 h-3.5" />}
              <span>
                {syncStatus === 'synced' && 'Synced'}
                {syncStatus === 'syncing' && 'Syncing'}
                {syncStatus === 'error' && 'Error'}
                {syncStatus === 'offline' && 'Sign In'}
              </span>
            </button>

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
              subscriptionCardById={subscriptionCardById}
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
              subscriptionCardById={subscriptionCardById}
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
          <div className="h-full overflow-y-auto animate-in fade-in duration-500">
            <CreditCardDashboard
              cards={visibleCreditCards}
              subscriptions={visibleSubscriptions}
              cardTransactions={visibleCardTransactions}
              categories={categories}
              currentDate={currentDate}
              onAddCard={addCreditCard}
              onUpdateCard={updateCreditCard}
              onDeleteCard={deleteCreditCard}
              onAddTransaction={addCardTransaction}
              onLogPayment={logCardPayment}
              onManageSubscriptions={() => setActiveView('subscriptions')}
              embedded
            />
          </div>
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
            creditCards={visibleCreditCards}
            currentDate={currentDate}
            onAdd={addSubscription}
            onUpdate={updateSubscription}
            onDelete={deleteSubscription}
            onStatusChange={changeSubscriptionStatus}
            onManageCards={() => setActiveView('creditCards')}
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
              <label className="text-[9px] uppercase font-bold tracking-wider text-slate-500">Amount</label>
              <input
                required
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="border border-slate-200 p-2 text-xs font-mono outline-none focus:bg-blue-50 focus:border-blue-500 rounded transition-all"
                placeholder="0.00"
              />
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
        </form>
      </footer>

      {/* Cloud Sync Modal */}
      {showSyncModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setShowSyncModal(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="text-xs uppercase font-bold tracking-widest text-slate-500">Firebase Cloud Sync</h3>
              <button onClick={() => setShowSyncModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Status Section */}
            <div className="bg-slate-50 p-4 rounded-lg flex items-center gap-3 border border-slate-100">
              <div className="p-2 rounded-full bg-white shadow-sm flex items-center justify-center w-10 h-10 shrink-0">
                {syncStatus === 'synced' && <Cloud className="w-6 h-6 text-emerald-600" />}
                {syncStatus === 'syncing' && <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />}
                {syncStatus === 'error' && <CloudOff className="w-6 h-6 text-rose-600" />}
                {syncStatus === 'offline' && <CloudOff className="w-6 h-6 text-slate-400" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-700">
                  {syncStatus === 'synced' && `Synced — ${currentUser?.email}`}
                  {syncStatus === 'syncing' && 'Saving changes to cloud...'}
                  {syncStatus === 'error' && 'Failed to sync. Will retry on next change.'}
                  {syncStatus === 'offline' && 'Local only — sign in to sync across devices'}
                </p>
                <p className="text-[10px] text-slate-500">
                  {syncStatus === 'offline' ? 'Data saved on this device only' : 'Firebase Cloud Sync'}
                </p>
              </div>
            </div>

            {authError && (
              <div className="p-3 bg-rose-50 text-rose-800 text-xs rounded border border-rose-100 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{authError}</span>
              </div>
            )}

            {/* Sign In / Sign Out */}
            {!currentUser ? (
              <form onSubmit={handleSignIn} className="space-y-3 border-t border-slate-100 pt-3">
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  Sign in to automatically sync your budget across all your devices.
                </p>
                <label className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase font-bold tracking-wider text-slate-400">Email Address</span>
                  <input
                    type="email"
                    required
                    value={authEmail}
                    onChange={e => setAuthEmail(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded text-xs focus:outline-none focus:border-blue-500 font-mono"
                    placeholder="you@example.com"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase font-bold tracking-wider text-slate-400">Password</span>
                  <input
                    type="password"
                    required
                    value={authPassword}
                    onChange={e => setAuthPassword(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded text-xs focus:outline-none focus:border-blue-500 font-mono"
                    placeholder="••••••••"
                  />
                </label>
                <button
                  type="submit"
                  disabled={isAuthSubmitting}
                  className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white text-[10px] font-bold uppercase tracking-wider py-2.5 hover:bg-blue-700 rounded transition-colors disabled:bg-blue-400"
                >
                  {isAuthSubmitting && <Loader2 className="w-3 h-3 animate-spin" />}
                  Sign In & Sync
                </button>
              </form>
            ) : (
              <div className="space-y-3 border-t border-slate-100 pt-3">
                <button
                  onClick={handleSignOut}
                  className="w-full flex items-center justify-center gap-2 border border-slate-200 text-slate-700 text-[10px] font-bold uppercase tracking-wider py-2.5 hover:bg-slate-50 rounded transition-colors"
                >
                  Sign Out
                </button>
              </div>
            )}

            {/* Force Actions Section */}
            <div className="border-t border-slate-100 pt-3 space-y-2">
              <h4 className="text-[9px] uppercase font-bold tracking-widest text-slate-400 mb-1">Manual Cloud Sync</h4>
              <div className="flex gap-2">
                <button 
                  onClick={forceUploadToCloud}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-slate-200 text-[9px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-50 hover:text-blue-600 transition-colors"
                >
                  Upload Local
                </button>
                <button 
                  onClick={forceDownloadFromCloud}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-slate-200 text-[9px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-50 hover:text-blue-600 transition-colors"
                >
                  Download Cloud
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const CARD_NETWORKS: CardNetwork[] = ['Visa', 'Mastercard', 'Amex', 'Discover', 'Other'];
const CARD_GRADIENTS = ['#1e3a8a', '#7c3aed', '#0f766e', '#b91c1c', '#9a3412', '#334155'];

type CardFormState = {
  name: string;
  last4: string;
  network: CardNetwork;
  limit: string;
  balance: string;
  minDue: string;
  dueDate: string;
  stmtCloseDate: string;
  apr: string;
  color: string;
};

const emptyCardForm = (): CardFormState => ({
  name: '',
  last4: '',
  network: 'Visa',
  limit: '',
  balance: '',
  minDue: '',
  dueDate: '',
  stmtCloseDate: '',
  apr: '',
  color: CARD_GRADIENTS[0],
});

const fmtDate = (iso?: string) => (iso ? format(parseISO(iso), 'MMM d') : '--');

function CreditCardDashboard({
  cards,
  subscriptions,
  cardTransactions,
  categories,
  currentDate,
  onAddCard,
  onUpdateCard,
  onDeleteCard,
  onAddTransaction,
  onLogPayment,
  onManageSubscriptions,
  embedded = false,
}: {
  cards: CreditCard[];
  subscriptions: Subscription[];
  cardTransactions: CardTransaction[];
  categories: string[];
  currentDate: Date;
  onAddCard: (input: CreditCardInput) => void;
  onUpdateCard: (id: string, changes: Partial<CreditCard>) => void;
  onDeleteCard: (id: string) => void;
  onAddTransaction: (input: CardTransactionInput) => void;
  onLogPayment: (cardId: string, amount: number, date: string, item?: string) => void;
  onManageSubscriptions: () => void;
  embedded?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(cards[0]?.id ?? null);
  const [showCardModal, setShowCardModal] = useState(false);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [cardForm, setCardForm] = useState<CardFormState>(emptyCardForm);
  const [showChargeModal, setShowChargeModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [balanceDraft, setBalanceDraft] = useState<string | null>(null);

  const today = format(new Date(), 'yyyy-MM-dd');
  const [chargeForm, setChargeForm] = useState({ description: '', amount: '', date: today, category: '', posted: true });
  const [paymentForm, setPaymentForm] = useState({ amount: '', date: today, item: '' });

  const selected = cards.find(c => c.id === selectedId) ?? cards[0] ?? null;

  const setCardField = <K extends keyof CardFormState>(key: K, value: CardFormState[K]) =>
    setCardForm(prev => ({ ...prev, [key]: value }));

  const openAddCard = () => {
    setEditingCardId(null);
    setCardForm(emptyCardForm());
    setShowCardModal(true);
  };

  const openEditCard = (card: CreditCard) => {
    setEditingCardId(card.id);
    setCardForm({
      name: card.name,
      last4: card.last4,
      network: card.network,
      limit: card.limit ? String(card.limit) : '',
      balance: card.balance ? String(card.balance) : '',
      minDue: card.minDue ? String(card.minDue) : '',
      dueDate: card.dueDate ? card.dueDate.slice(0, 10) : '',
      stmtCloseDate: card.stmtCloseDate ? card.stmtCloseDate.slice(0, 10) : '',
      apr: card.apr !== undefined ? String(card.apr) : '',
      color: card.color || CARD_GRADIENTS[0],
    });
    setShowCardModal(true);
  };

  const submitCard = () => {
    const name = cardForm.name.trim();
    const limit = parseFloat(cardForm.limit);
    const balance = parseFloat(cardForm.balance);
    if (!name || !Number.isFinite(limit) || !Number.isFinite(balance)) return;
    const input: CreditCardInput = {
      name,
      last4: cardForm.last4.replace(/\D/g, '').slice(-4),
      network: cardForm.network,
      limit,
      balance,
      minDue: parseFloat(cardForm.minDue) || 0,
      dueDate: cardForm.dueDate,
      stmtCloseDate: cardForm.stmtCloseDate,
      apr: cardForm.apr.trim() ? parseFloat(cardForm.apr) : undefined,
      color: cardForm.color,
    };
    if (editingCardId) {
      onUpdateCard(editingCardId, input);
    } else {
      onAddCard(input);
    }
    setShowCardModal(false);
    setEditingCardId(null);
  };

  const submitCharge = () => {
    if (!selected) return;
    const amount = parseFloat(chargeForm.amount);
    const description = chargeForm.description.trim();
    if (!description || !Number.isFinite(amount)) return;
    onAddTransaction({
      cardId: selected.id,
      description,
      amount,
      date: chargeForm.date,
      category: chargeForm.category,
      posted: chargeForm.posted,
    });
    // Logged charges raise the manually-maintained balance.
    onUpdateCard(selected.id, { balance: selected.balance + amount });
    setChargeForm({ description: '', amount: '', date: today, category: '', posted: true });
    setShowChargeModal(false);
  };

  const submitPayment = () => {
    if (!selected) return;
    const amount = parseFloat(paymentForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    onLogPayment(selected.id, amount, paymentForm.date, paymentForm.item.trim() || undefined);
    setPaymentForm({ amount: '', date: today, item: '' });
    setShowPaymentModal(false);
  };

  const commitBalance = () => {
    if (selected && balanceDraft !== null) {
      const next = parseFloat(balanceDraft);
      if (Number.isFinite(next)) onUpdateCard(selected.id, { balance: next });
    }
    setBalanceDraft(null);
  };

  const subsForCard = selected
    ? subscriptions.filter(s => s.cardId === selected.id && s.status === 'active')
    : [];
  const subsTotal = subsForCard.reduce((sum, s) => sum + getMonthlyEquivalent(s), 0);

  const cycleCharges = selected
    ? cardTransactions
        .filter(t => t.cardId === selected.id)
        .sort((a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime())
    : [];

  const utilization = selected ? getUtilization(selected) : null;
  const daysUntilDue = selected ? getDaysUntilDue(selected) : null;
  const dueSoon = daysUntilDue !== null && daysUntilDue <= 7;

  const inputClass = 'border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500';
  const labelClass = 'text-[10px] uppercase font-bold tracking-wider text-slate-500';

  return (
    <div className={cn(embedded ? 'px-8 pt-8 pb-2' : 'h-full overflow-y-auto p-8 animate-in fade-in duration-500')}>
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-end justify-between gap-6">
          <div>
            <h2 className="font-serif italic text-3xl tracking-tight text-slate-900 border-b-2 border-blue-600 inline-block mb-1">Card Dashboard</h2>
            <p className="text-xs text-slate-500 font-medium">Track what's on each card — balance, subscriptions, and charges.</p>
          </div>
          <button
            onClick={onManageSubscriptions}
            className="text-[11px] uppercase tracking-widest font-bold text-blue-600 hover:text-blue-800 transition-colors"
          >
            Manage Subscriptions →
          </button>
        </div>

        {/* Selector pills */}
        <div className="flex flex-wrap items-center gap-2">
          {cards.map(card => (
            <button
              key={card.id}
              onClick={() => setSelectedId(card.id)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all',
                selected?.id === card.id
                  ? 'border-slate-900 bg-slate-900 text-white shadow-sm'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'
              )}
            >
              {card.name}{card.last4 ? ` ••${card.last4}` : ''}
            </button>
          ))}
          <button
            onClick={openAddCard}
            className="rounded-full border border-dashed border-slate-300 px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-blue-600 hover:bg-blue-50 transition-colors flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> Add Card
          </button>
        </div>

        {!selected ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
            <CreditCardIcon className="w-8 h-8 text-slate-300 mx-auto mb-3" />
            <p className="text-sm font-serif italic text-slate-400">No cards yet. Add one to start tracking balances and charges.</p>
          </div>
        ) : (
          <>
            {/* Card visual */}
            <div
              className="rounded-2xl p-6 text-white shadow-lg relative overflow-hidden"
              style={{ background: `linear-gradient(135deg, ${selected.color || CARD_GRADIENTS[0]}, #0f172a)` }}
            >
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.3em] opacity-70 font-bold">{selected.network}</p>
                  <p className="font-serif italic text-2xl mt-1">{selected.name}</p>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => openEditCard(selected)} className="p-1.5 rounded hover:bg-white/15 transition-colors" title="Edit card">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete card "${selected.name}"? Its subscriptions and charges will remain but become unlinked.`)) {
                        onDeleteCard(selected.id);
                        setSelectedId(null);
                      }
                    }}
                    className="p-1.5 rounded hover:bg-white/15 transition-colors"
                    title="Delete card"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="flex justify-between items-end mt-8">
                <p className="font-mono text-lg tracking-widest">•••• •••• •••• {selected.last4 || '••••'}</p>
                <div className="text-right">
                  <p className="text-[9px] uppercase tracking-widest opacity-60 font-bold">Stmt Close</p>
                  <p className="font-mono text-xs">{fmtDate(selected.stmtCloseDate)}</p>
                </div>
              </div>
            </div>

            {/* Due banner */}
            <div className={cn(
              'flex items-center justify-between rounded-lg border px-4 py-3',
              dueSoon ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'
            )}>
              <div className="flex items-center gap-2">
                {dueSoon && <AlertTriangle className="w-4 h-4 text-rose-600" />}
                <span className={cn('text-xs font-semibold', dueSoon ? 'text-rose-700' : 'text-slate-600')}>
                  Payment due {fmtDate(selected.dueDate)}
                  {daysUntilDue !== null && (
                    <span className="font-mono ml-2">
                      {daysUntilDue < 0 ? `${Math.abs(daysUntilDue)}d overdue` : daysUntilDue === 0 ? 'due today' : `in ${daysUntilDue}d`}
                    </span>
                  )}
                </span>
              </div>
              <button
                onClick={() => { setPaymentForm({ amount: selected.minDue ? String(selected.minDue) : '', date: today, item: '' }); setShowPaymentModal(true); }}
                className="flex items-center gap-1.5 rounded bg-slate-900 px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold text-white hover:bg-slate-800 transition-colors"
              >
                <Wallet className="w-3 h-3" /> Log Payment
              </button>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-4">
              <div className="border border-slate-200 bg-white p-4 rounded-lg shadow-sm">
                <p className="text-[9px] uppercase font-bold tracking-widest text-slate-500 mb-1">Balance</p>
                {balanceDraft !== null ? (
                  <input
                    autoFocus
                    type="number"
                    step="0.01"
                    value={balanceDraft}
                    onChange={e => setBalanceDraft(e.target.value)}
                    onBlur={commitBalance}
                    onKeyDown={e => { if (e.key === 'Enter') commitBalance(); if (e.key === 'Escape') setBalanceDraft(null); }}
                    className="font-mono text-xl font-bold text-rose-600 w-full outline-none border-b border-rose-300"
                  />
                ) : (
                  <button onClick={() => setBalanceDraft(String(selected.balance))} className="font-mono text-xl font-bold text-rose-600 hover:underline" title="Click to update balance">
                    ${formatMoney(selected.balance)}
                  </button>
                )}
              </div>
              <div className="border border-slate-200 bg-white p-4 rounded-lg shadow-sm">
                <p className="text-[9px] uppercase font-bold tracking-widest text-slate-500 mb-1">Available</p>
                <p className="font-mono text-xl font-bold text-emerald-600">${formatMoney(getAvailableCredit(selected))}</p>
              </div>
              <div className="border border-slate-200 bg-white p-4 rounded-lg shadow-sm">
                <p className="text-[9px] uppercase font-bold tracking-widest text-slate-500 mb-1">Min Due</p>
                <p className="font-mono text-xl font-bold text-amber-600">${formatMoney(selected.minDue)}</p>
              </div>
            </div>

            {/* Utilization bar */}
            <div className="border border-slate-200 bg-white p-4 rounded-lg shadow-sm">
              <div className="flex justify-between items-center mb-2">
                <span className="text-[9px] uppercase font-bold tracking-widest text-slate-500">Utilization</span>
                <span className={cn('font-mono text-xs font-bold', utilization !== null && utilization >= 0.3 ? 'text-rose-600' : 'text-emerald-600')}>
                  {utilization === null ? '--' : `${Math.round(utilization * 100)}%`}
                </span>
              </div>
              <div className="h-3 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min((utilization ?? 0) * 100, 100)}%`,
                    background: utilization !== null && utilization >= 0.3
                      ? 'linear-gradient(90deg, #f59e0b, #e11d48)'
                      : 'linear-gradient(90deg, #34d399, #10b981)',
                  }}
                />
              </div>
              <p className="text-[10px] text-slate-400 mt-1.5 font-mono">Limit ${formatMoney(selected.limit)}</p>
            </div>

            {/* Subscriptions this cycle */}
            <div className="border border-slate-200 bg-white rounded-lg shadow-sm overflow-hidden">
              <div className="flex justify-between items-center px-4 py-3 border-b border-slate-100">
                <h3 className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Subscriptions This Cycle</h3>
                <span className="font-mono text-xs font-bold text-violet-600">${formatMoney(subsTotal)}/mo</span>
              </div>
              {subsForCard.length === 0 ? (
                <p className="p-6 text-center text-xs text-slate-400 italic font-serif">
                  No active subscriptions on this card. <button onClick={onManageSubscriptions} className="text-blue-600 not-italic font-bold hover:underline">Add one →</button>
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {subsForCard.map(sub => {
                    const billsThisMonth = subscriptionBillsInMonth(sub, currentDate);
                    const posted = billsThisMonth && currentDate.getDate() >= Math.min(sub.billingDay, 28);
                    const statusLabel = !billsThisMonth ? 'Not this cycle' : posted ? 'Posted' : 'Upcoming';
                    return (
                      <li key={sub.id} className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-sans font-bold text-slate-900 text-xs">{sub.name}</span>
                          <span className={cn(
                            'inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider',
                            !billsThisMonth
                              ? 'border-slate-100 bg-slate-50 text-slate-400'
                              : posted
                                ? 'border-slate-200 bg-slate-50 text-slate-500'
                                : 'border-blue-200 bg-blue-50 text-blue-700'
                          )}>
                            {statusLabel}
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="font-mono text-xs font-bold text-slate-900">${formatMoney(sub.amount)}</span>
                          <span className="font-mono text-[10px] text-slate-400 ml-2">day {sub.billingDay}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Ad hoc charges */}
            <div className="border border-slate-200 bg-white rounded-lg shadow-sm overflow-hidden">
              <div className="flex justify-between items-center px-4 py-3 border-b border-slate-100">
                <h3 className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Charges & Payments</h3>
                <button
                  onClick={() => setShowChargeModal(true)}
                  className="flex items-center gap-1 text-[10px] uppercase tracking-widest font-bold text-blue-600 hover:text-blue-800 transition-colors"
                >
                  <Plus className="w-3 h-3" /> Log Charge
                </button>
              </div>
              {cycleCharges.length === 0 ? (
                <p className="p-6 text-center text-xs text-slate-400 italic font-serif">No charges logged yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {cycleCharges.map(txn => (
                    <li key={txn.id} className="flex items-center justify-between px-4 py-3">
                      <div className="flex flex-col">
                        <span className="font-sans font-bold text-slate-900 text-xs">{txn.description}</span>
                        <span className="font-mono text-[10px] text-slate-400">{fmtDate(txn.date)}{txn.category ? ` · ${txn.category}` : ''}{!txn.posted ? ' · pending' : ''}</span>
                      </div>
                      <span className={cn('font-mono text-xs font-bold', txn.amount < 0 ? 'text-emerald-600' : 'text-slate-900')}>
                        {txn.amount < 0 ? '-' : ''}${formatMoney(Math.abs(txn.amount))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {/* Add/Edit Card modal */}
      {showCardModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setShowCardModal(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="text-xs uppercase font-bold tracking-widest text-slate-500">{editingCardId ? 'Edit Card' : 'Add Card'}</h3>
              <button onClick={() => setShowCardModal(false)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <label className="flex flex-col gap-1 col-span-2 md:col-span-1">
                <span className={labelClass}>Name *</span>
                <input value={cardForm.name} onChange={e => setCardField('name', e.target.value)} className={inputClass} placeholder="Chase Disney" />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Last 4</span>
                <input value={cardForm.last4} onChange={e => setCardField('last4', e.target.value)} maxLength={4} className={inputClass} placeholder="1234" />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Network</span>
                <select value={cardForm.network} onChange={e => setCardField('network', e.target.value as CardNetwork)} className={inputClass}>
                  {CARD_NETWORKS.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Credit Limit *</span>
                <input type="number" step="0.01" value={cardForm.limit} onChange={e => setCardField('limit', e.target.value)} className={inputClass} placeholder="5000" />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Current Balance *</span>
                <input type="number" step="0.01" value={cardForm.balance} onChange={e => setCardField('balance', e.target.value)} className={inputClass} placeholder="1200" />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Min Due</span>
                <input type="number" step="0.01" value={cardForm.minDue} onChange={e => setCardField('minDue', e.target.value)} className={inputClass} placeholder="35" />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Due Date</span>
                <input type="date" value={cardForm.dueDate} onChange={e => setCardField('dueDate', e.target.value)} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Statement Close</span>
                <input type="date" value={cardForm.stmtCloseDate} onChange={e => setCardField('stmtCloseDate', e.target.value)} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>APR (optional)</span>
                <input type="number" step="0.01" value={cardForm.apr} onChange={e => setCardField('apr', e.target.value)} className={inputClass} placeholder="24.99" />
              </label>
            </div>
            <div className="flex items-center gap-3">
              <span className={labelClass}>Color</span>
              <div className="flex gap-1.5">
                {CARD_GRADIENTS.map(c => (
                  <button key={c} type="button" onClick={() => setCardField('color', c)} className={cn('w-5 h-5 rounded-full border-2 transition-transform', cardForm.color === c ? 'border-slate-900 scale-110' : 'border-transparent')} style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={submitCard} className="px-5 bg-blue-600 text-white text-[11px] uppercase tracking-widest font-bold py-2.5 hover:bg-blue-700 rounded transition-colors">
                {editingCardId ? 'Save Changes' : 'Add Card'}
              </button>
              <button onClick={() => setShowCardModal(false)} className="px-5 border border-slate-200 text-slate-600 text-[11px] uppercase tracking-widest font-bold py-2.5 hover:bg-slate-50 rounded transition-colors">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Log Charge modal */}
      {showChargeModal && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setShowChargeModal(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="text-xs uppercase font-bold tracking-widest text-slate-500">Log Charge · {selected.name}</h3>
              <button onClick={() => setShowChargeModal(false)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1 col-span-2">
                <span className={labelClass}>Description *</span>
                <input value={chargeForm.description} onChange={e => setChargeForm(p => ({ ...p, description: e.target.value }))} className={inputClass} placeholder="Amazon order" />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Amount *</span>
                <input type="number" step="0.01" value={chargeForm.amount} onChange={e => setChargeForm(p => ({ ...p, amount: e.target.value }))} className={inputClass} placeholder="42.10" />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Date</span>
                <input type="date" value={chargeForm.date} onChange={e => setChargeForm(p => ({ ...p, date: e.target.value }))} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 col-span-2">
                <span className={labelClass}>Category</span>
                <select value={chargeForm.category} onChange={e => setChargeForm(p => ({ ...p, category: e.target.value }))} className={inputClass}>
                  <option value="">--</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <button type="button" onClick={() => setChargeForm(p => ({ ...p, posted: !p.posted }))} className={cn('w-9 h-5 rounded-full transition-colors relative', chargeForm.posted ? 'bg-blue-600' : 'bg-slate-300')}>
                <span className={cn('absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all', chargeForm.posted ? 'left-[18px]' : 'left-0.5')} />
              </button>
              <span className="text-[11px] font-semibold text-slate-600">Posted (confirmed charge)</span>
            </label>
            <div className="flex gap-3 pt-2">
              <button onClick={submitCharge} className="px-5 bg-blue-600 text-white text-[11px] uppercase tracking-widest font-bold py-2.5 hover:bg-blue-700 rounded transition-colors">Log Charge</button>
              <button onClick={() => setShowChargeModal(false)} className="px-5 border border-slate-200 text-slate-600 text-[11px] uppercase tracking-widest font-bold py-2.5 hover:bg-slate-50 rounded transition-colors">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Log Payment modal */}
      {showPaymentModal && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setShowPaymentModal(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="text-xs uppercase font-bold tracking-widest text-slate-500">Log Payment · {selected.name}</h3>
              <button onClick={() => setShowPaymentModal(false)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-[11px] text-slate-500">Reduces this card's balance. Any subscriptions already in the ledger this month are covered — the rest of the payment is logged as one expense.</p>
            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Amount *</span>
                <input type="number" step="0.01" value={paymentForm.amount} onChange={e => setPaymentForm(p => ({ ...p, amount: e.target.value }))} className={inputClass} placeholder={selected.minDue ? String(selected.minDue) : '0.00'} />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Date</span>
                <input type="date" value={paymentForm.date} onChange={e => setPaymentForm(p => ({ ...p, date: e.target.value }))} className={inputClass} />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Item (optional)</span>
              <input type="text" value={paymentForm.item} onChange={e => setPaymentForm(p => ({ ...p, item: e.target.value }))} className={inputClass} placeholder="e.g. Costco, gas, dining" />
              <span className="text-[10px] text-slate-400">Labels the leftover charges beyond your linked subscriptions.</span>
            </label>
            <div className="flex gap-3 pt-2">
              <button onClick={submitPayment} className="px-5 bg-slate-900 text-white text-[11px] uppercase tracking-widest font-bold py-2.5 hover:bg-slate-800 rounded transition-colors">Log Payment</button>
              <button onClick={() => setShowPaymentModal(false)} className="px-5 border border-slate-200 text-slate-600 text-[11px] uppercase tracking-widest font-bold py-2.5 hover:bg-slate-50 rounded transition-colors">Cancel</button>
            </div>
          </div>
        </div>
      )}
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
  subscriptionCardById,
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
  subscriptionCardById: Map<string, CreditCard>;
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
          <thead className="sticky top-0 bg-slate-50 z-5">
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
                      </td>
                      <td className="p-3 border-r border-slate-100 text-slate-500">
                        <span className="truncate block max-w-[100px]">{t.category || '--'}</span>
                      </td>
                      <td className="p-3 border-r border-slate-100">
                        {t.type === 'debit' ? (
                          t.recurringId && subscriptionCardById.has(t.recurringId) ? (
                            <span
                              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-slate-500"
                              title="Settled when you pay this card's bill — not paid individually"
                            >
                              <CreditCardIcon className="w-3 h-3" />
                              {subscriptionCardById.get(t.recurringId)!.name}
                            </span>
                          ) : (
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
                          )
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
  renewalDate: string;
  trialEndDate: string;
  autoCreateTransaction: boolean;
  cardId: string;
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
  renewalDate: '',
  trialEndDate: '',
  autoCreateTransaction: true,
  cardId: '',
  url: '',
  notes: '',
  color: SUBSCRIPTION_COLORS[0],
});

function SubscriptionsView({
  subscriptions,
  categories,
  creditCards,
  currentDate,
  onAdd,
  onUpdate,
  onDelete,
  onStatusChange,
  onManageCards,
}: {
  subscriptions: Subscription[];
  categories: string[];
  creditCards: CreditCard[];
  currentDate: Date;
  onAdd: (input: SubscriptionInput) => void;
  onUpdate: (id: string, changes: Partial<Subscription>) => void;
  onDelete: (id: string, deleteTransactions?: boolean) => void;
  onStatusChange: (id: string, status: SubscriptionStatus) => void;
  onManageCards: () => void;
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
      renewalDate: sub.renewalDate ? sub.renewalDate.slice(0, 10) : '',
      trialEndDate: sub.trialEndDate ? sub.trialEndDate.slice(0, 10) : '',
      autoCreateTransaction: sub.autoCreateTransaction,
      cardId: sub.cardId || '',
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
      renewalDate: form.renewalDate || undefined,
      trialEndDate: form.trialEndDate || undefined,
      autoCreateTransaction: form.autoCreateTransaction,
      cardId: form.cardId || undefined,
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
                <th className="p-4">Card</th>
                <th className="p-4">Category</th>
                <th className="p-4 text-right">Amount</th>
                <th className="p-4">Cycle</th>
                <th className="p-4">Renewal Date</th>
                <th className="p-4">Status</th>
                <th className="p-4 text-center">Auto-Ledger</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="text-xs">
              {subscriptions.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-12 text-center text-slate-400 italic font-serif">
                    No subscriptions yet. Add one to start tracking recurring spend.
                  </td>
                </tr>
              )}
              {[...subscriptions]
                .sort((a, b) => getMonthlyEquivalent(b) - getMonthlyEquivalent(a))
                .map(sub => {
                  const isTrial = !!sub.trialEndDate && parseISO(sub.trialEndDate) > today;
                  const linkedCard = sub.cardId ? creditCards.find(c => c.id === sub.cardId) : null;
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
                      <td className="p-4 font-sans text-xs">
                        {linkedCard ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-bold text-slate-700">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: linkedCard.color || '#334155' }} />
                            {linkedCard.name}{linkedCard.last4 ? ` ••${linkedCard.last4}` : ''}
                          </span>
                        ) : (
                          <span className="text-slate-300">--</span>
                        )}
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
                        {sub.renewalDate
                          ? format(parseISO(sub.renewalDate), 'MMM d, yyyy')
                          : sub.status === 'active'
                            ? <span>{format(parseISO(getNextBillingDate(sub, currentDate)), 'MMM d')}<span className="font-sans text-[9px] text-slate-400 ml-1">computed</span></span>
                            : '--'}
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
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Card</span>
                {creditCards.length === 0 ? (
                  <button
                    type="button"
                    onClick={onManageCards}
                    className="border border-dashed border-slate-300 p-2 text-xs rounded text-left text-blue-600 hover:bg-blue-50 transition-colors"
                  >
                    Add a credit card first →
                  </button>
                ) : (
                  <select value={form.cardId} onChange={e => setField('cardId', e.target.value)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500">
                    <option value="">Not on a tracked card</option>
                    {creditCards.map(c => (
                      <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` ••${c.last4}` : ''}</option>
                    ))}
                  </select>
                )}
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
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Renewal Date <span className="normal-case text-slate-400 font-normal">(optional)</span></span>
                <input type="date" value={form.renewalDate} onChange={e => setField('renewalDate', e.target.value)} className="border border-slate-200 p-2 text-xs rounded outline-none focus:bg-blue-50 focus:border-blue-500" />
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

            {form.cardId && (
              <p className="text-[10px] text-slate-500 font-semibold">
                This subscription will still appear in your ledger's Bills area as a "Charged to [Card]" badge — that's expected, it's already settled by the card's payment, not a separate bill to pay. If you'd
                <em> also</em> entered this same bill by hand as a plain recurring transaction before linking it here, delete that duplicate — otherwise it'll double-count toward your monthly totals.
              </p>
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
