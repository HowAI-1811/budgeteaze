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
  Circle
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
import { Transaction, TransactionType } from './types';

const STORAGE_KEY = 'cyclebudget_data';
const CATEGORY_STORAGE_KEY = 'cyclebudget_categories';
type ViewType = 'ledger' | 'dashboard' | 'recurring' | 'categories';

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

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
  }, [transactions]);

  useEffect(() => {
    localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(categories));
  }, [categories]);

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
          .filter(t => t.isRecurring && t.recurringId)
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
  }, [currentDate]); 

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
    if (!description || !amount) return;

    const recurringId = editingTransaction?.recurringId || (isRecurring ? crypto.randomUUID() : undefined);

    const newTransaction: Transaction = {
      id: editingTransaction?.id || crypto.randomUUID(),
      description,
      amount: parseFloat(amount),
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
              description,
              amount: parseFloat(amount),
              category,
              type,
              notes,
              isRecurring: true // Keep it recurring
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

  const handleExportCSV = () => {
    const headers = ['Date', 'Description', 'Category', 'Type', 'Amount', 'Paid', 'Recurring', 'Notes'];
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
      version: 1,
      exportedAt: new Date().toISOString(),
      categories,
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

      const shouldReplace = confirm(
        `Import ${importedTransactions.length} transactions and ${importedCategories.length} categories?\nThis will replace your current saved data.`
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
    const trendData = [];
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
        Balance: income - expenses
      });
    }

    return { pieData, trendData };
  }, [monthTransactions, transactions, currentDate]);

  const COLORS = ['#2563EB', '#7C3AED', '#DB2777', '#EA580C', '#F59E0B', '#10B981', '#06B6D4', '#6366F1'];

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-50">
      {/* Header Section */}
      <header className="border-b border-slate-200 px-8 py-4 flex justify-between items-center bg-white shrink-0 shadow-sm z-10">
        <div className="flex flex-col">
          <div className="flex items-center gap-6">
            <h1 className="font-serif italic text-2xl tracking-tight text-slate-900">Split-Cycle Ledger</h1>
            
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

            <div className="flex items-center gap-1 ml-4 border border-slate-200 rounded p-0.5 bg-slate-50">
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

            <button 
              onClick={handleExportCSV}
              className="flex items-center gap-2 px-3 py-1.5 border border-slate-200 rounded-md text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-50 hover:text-blue-600 transition-all ml-2"
              title="Export Month as CSV"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
            <button 
              onClick={handleExportJSON}
              className="flex items-center gap-2 px-3 py-1.5 border border-slate-200 rounded-md text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-50 hover:text-blue-600 transition-all"
              title="Export All Data as JSON Backup"
            >
              <Download className="w-3.5 h-3.5" />
              Backup JSON
            </button>
            <button 
              onClick={() => importInputRef.current?.click()}
              className="flex items-center gap-2 px-3 py-1.5 border border-slate-200 rounded-md text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-50 hover:text-blue-600 transition-all"
              title="Import JSON Backup"
            >
              <Upload className="w-3.5 h-3.5" />
              Import JSON
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

        <div className="flex gap-8 text-right">
          <div>
            <p className="text-[9px] uppercase tracking-widest opacity-40 font-bold mb-0.5 text-slate-500">Total Income</p>
            <p className="font-mono text-lg font-bold text-emerald-600">
              ${formatMoney(totalIncome)}
            </p>
            <MoneyDelta delta={monthComparison.incomeDelta} toneType="credit" label={monthComparison.previousMonthLabel} />
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-widest opacity-40 font-bold mb-0.5 text-slate-500">Total Expenses</p>
            <p className="font-mono text-lg font-bold text-rose-600">
              ${formatMoney(totalExpenses)}
            </p>
            <MoneyDelta delta={monthComparison.expensesDelta} toneType="debit" label={monthComparison.previousMonthLabel} />
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-widest opacity-40 font-bold mb-0.5 text-slate-500">Total Net</p>
            <p className="font-mono text-lg font-bold text-slate-900">
              ${formatMoney(totalBalance)}
            </p>
            <MoneyDelta delta={monthComparison.balanceDelta} toneType="balance" label={monthComparison.previousMonthLabel} />
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-widest opacity-40 font-bold mb-0.5 text-slate-500">Savings Rate</p>
            <p className={cn(
              "font-mono text-lg font-bold",
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
              headerBg="bg-slate-100"
              headerText="text-slate-900"
              borderLeft
            />
          </div>
        ) : activeView === 'dashboard' ? (
          <div className="h-full overflow-y-auto p-8 space-y-8 animate-in fade-in duration-500">
            <div className="grid grid-cols-4 gap-6">
              {[
                { label: 'Total Income', val: totalIncome, color: 'text-emerald-600', bg: 'bg-emerald-50' },
                { label: 'Total Expenses', val: totalExpenses, color: 'text-rose-600', bg: 'bg-rose-50' },
                { label: 'Net Cash Flow', val: totalBalance, color: totalBalance >= 0 ? 'text-blue-600' : 'text-rose-700', bg: 'bg-blue-50' },
                { label: 'Monthly Burn', val: totalExpenses / (monthTransactions.length || 1), color: 'text-slate-600', bg: 'bg-slate-100' }
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
                        contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                        cursor={{ fill: '#F1F5F9' }}
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
                       return (
                         <tr key={rid} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                           <td className="p-4 text-slate-400">Day {getDate(parseISO(latest.date))}</td>
                           <td className="p-4 font-sans font-bold text-slate-900">{latest.description}</td>
                           <td className="p-4 font-sans text-slate-500">{latest.category || '--'}</td>
                           <td className={cn("p-4 text-right font-bold", latest.type === 'credit' ? 'text-emerald-600' : 'text-slate-900')}>
                             {latest.type === 'credit' ? '+' : '-'}${latest.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                           </td>
                           <td className="p-4 text-right space-x-2">
                             <button 
                               onClick={() => {
                                 setActiveView('ledger');
                                 editTransaction(latest);
                               }}
                               className="p-1 px-3 border border-slate-200 rounded text-blue-600 hover:bg-blue-50 transition-all font-sans font-bold text-[10px] uppercase"
                             >
                               Edit Series
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
      <footer className="border-t border-slate-200 p-6 bg-white shrink-0">
        <form onSubmit={handleAddOrUpdate} className="flex items-end gap-6 max-w-7xl mx-auto">
          <div className="flex-1 grid grid-cols-7 gap-4">
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
        </form>
      </footer>
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
                          {t.isRecurring && <RefreshCw className="w-2.5 h-2.5 text-blue-500 shrink-0" />}
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
