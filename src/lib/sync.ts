import { db } from './firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import type { Transaction, Subscription, CreditCard, CardTransaction } from '../types';

export interface BudgetData {
  transactions: Transaction[];
  categories: string[];
  subscriptions: Subscription[];
  creditCards: CreditCard[];
  cardTransactions: CardTransaction[];
  updatedAt?: string; // ISO timestamp
}

export const loadFromCloud = async (uid: string): Promise<BudgetData | null> => {
  const docRef = doc(db, 'users', uid, 'data', 'budget');
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap.data() as BudgetData;
  }
  return null;
};

export const saveToCloud = async (uid: string, data: BudgetData): Promise<string> => {
  const docRef = doc(db, 'users', uid, 'data', 'budget');
  const timestamp = new Date().toISOString();
  // JSON round-trip strips all `undefined` values — Firestore rejects them at any depth
  const payload = JSON.parse(JSON.stringify({
    transactions: data.transactions || [],
    categories: data.categories || [],
    subscriptions: data.subscriptions || [],
    creditCards: data.creditCards || [],
    cardTransactions: data.cardTransactions || [],
    updatedAt: timestamp,
  }));
  await setDoc(docRef, payload);
  localStorage.setItem('cyclebudget_last_updated', timestamp);
  return timestamp;
};

// Debounce timer for saving to cloud
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export const saveToCloudDebounced = (
  uid: string,
  data: BudgetData,
  onSyncStatusChange?: (status: 'syncing' | 'synced' | 'error') => void
) => {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  if (onSyncStatusChange) {
    onSyncStatusChange('syncing');
  }

  debounceTimer = setTimeout(async () => {
    try {
      await saveToCloud(uid, data);
      if (onSyncStatusChange) {
        onSyncStatusChange('synced');
      }
    } catch (error) {
      console.error('Failed to sync to cloud:', error);
      if (onSyncStatusChange) {
        onSyncStatusChange('error');
      }
    }
  }, 2000); // 2 second debounce to prevent Firestore write spam
};
