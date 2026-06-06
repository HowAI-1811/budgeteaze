/**
 * Persistence seam.
 *
 * Every read/write of durable app data goes through a StorageAdapter instead of
 * touching `localStorage` directly. Today the only implementation is
 * `LocalStorageAdapter`. When the app grows into multi-device sync, you add a
 * remote-backed adapter (or a SyncStorageAdapter that wraps local + remote with
 * last-write-wins reconciliation) and swap the `storage` export below — no call
 * sites change.
 */

export interface StorageAdapter {
  read<T>(key: string, fallback: T): T;
  write<T>(key: string, value: T): void;
  remove(key: string): void;
}

class LocalStorageAdapter implements StorageAdapter {
  read<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  write<T>(key: string, value: T): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota errors / private-mode failures are swallowed deliberately:
      // the in-memory React state stays the source of truth for the session.
    }
  }

  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // no-op
    }
  }
}

export const storage: StorageAdapter = new LocalStorageAdapter();
