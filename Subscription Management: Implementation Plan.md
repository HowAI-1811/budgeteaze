# BudgetEaze — Subscription Management: Implementation Plan

## Codebase Snapshot (as read)

Before the plan, here is what the codebase actually contains — the plan references all of
this explicitly.

| File               | Role                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `src/App.tsx`      | Single monolithic component file. All components, all state, all views. ~2,400 lines.       |
| `src/types.ts`     | `Transaction`, `TransactionType`, `AccountType`, `CycleBudget`, `PaymentCycle`              |
| `src/lib/utils.ts` | `cn()` only (clsx + tailwind-merge)                                                         |
| `src/main.tsx`     | Entry point, `StrictMode` wrapper                                                           |
| `src/index.css`    | Tailwind v4, fonts: Crimson Pro (serif), JetBrains Mono (mono), Inter (sans)                |
| `vite.config.ts`   | Vite + Tailwind plugin, injects `GEMINI_API_KEY` as `process.env`, `@` alias → project root |
| `server.ts`        | Empty — Gemini SDK installed (`@google/genai`) but completely unused                        |

**State architecture:** All state lives in the `App()` default export via `useState`/`useMemo`.
No context, no Zustand, no Redux.

**View routing:** A single `activeView` state of type `ViewType` switches between rendered sections.

```ts
// current
type ViewType =
  | "ledger"
  | "dashboard"
  | "creditCards"
  | "recurring"
  | "categories";
```

**localStorage keys (current):**

```ts
const STORAGE_KEY = "cyclebudget_data"; // Transaction[]
const CATEGORY_STORAGE_KEY = "cyclebudget_categories"; // string[]
```

**Inline components (all in App.tsx):**

- `App` — root, owns all state
- `CyclePane` — renders one half of the split-cycle ledger
- `CreditCardsView` — the credit cards view
- `MoneyDelta` — +/- delta chip
- `PercentDelta` — percentage delta chip
- `PaymentPosture` — above/below minimum label

**Recurring transaction logic (critical context):**
A `useEffect` keyed on `currentDate` scans `transactions` for recurring series and
auto-populates missing entries for the viewed month by cloning the most recent entry in
each series. This is the pattern the subscription injection will mirror — and must not
conflict with.

---

## 1. What "Subscription" Means in This App

A subscription is a **named, vendor-specific recurring billing agreement** with its own
lifecycle (active → paused → cancelled). It differs from the existing `isRecurring`
transaction flag in three concrete ways:

1. **It is an entity, not a flag.** Subscriptions have independent metadata (service name,
   billing URL, trial dates, price-change history intent) that does not belong on a
   `Transaction` row.

2. **It has a billing cycle that is not always monthly.** The existing recurring system
   clones month-to-month unconditionally. A subscription may be annual (charged once,
   in a specific month) or quarterly. Injecting it naively every month would be wrong.

3. **It has a status.** Subscriptions can be paused or cancelled — states that must suppress
   ledger injection without deleting the subscription record.

The relationship is: one `Subscription` → zero or many auto-generated `Transaction` rows,
linked by `recurringId === subscription.id`. When a subscription is cancelled, future
auto-injection stops; past transactions remain intact in the ledger.

---

## 2. Data Model

### 2.1 New types — add to `src/types.ts`

```ts
// src/types.ts

export type BillingCycle = "weekly" | "monthly" | "quarterly" | "annual";

export type SubscriptionStatus = "active" | "paused" | "cancelled";

export interface Subscription {
  // Identity
  id: string; // crypto.randomUUID()
  name: string; // "Netflix", "Spotify Premium", "Planet Fitness"
  vendor?: string; // optional separate vendor field ("Netflix Inc.")

  // Billing
  amount: number; // cost per billingCycle
  billingCycle: BillingCycle; // 'weekly' | 'monthly' | 'quarterly' | 'annual'
  billingDay: number; // day-of-month for the charge (1–28; capped at 28
  // to avoid Feb/30-day-month edge cases)
  category?: string; // must match an entry in the categories list

  // Lifecycle
  status: SubscriptionStatus; // 'active' | 'paused' | 'cancelled'
  startDate: string; // ISO date — first real charge date
  cancelledDate?: string; // ISO date — set when status → 'cancelled'
  trialEndDate?: string; // ISO date — free trial ends; charge begins after

  // Ledger integration
  autoCreateTransaction: boolean; // true → inject a Transaction each billing period

  // Optional metadata
  url?: string; // management/cancellation URL
  notes?: string;
  color?: string; // hex or Tailwind color token for UI badge
}
```

### 2.2 Computed helper (not stored — derive at render time)

```ts
// src/types.ts or inline in App.tsx

export type NormalizedMonthlyAmount = {
  monthly: number; // the per-month equivalent cost
  annual: number; // monthly × 12
};

// Utility function (add to App.tsx alongside formatMoney):
const getMonthlyEquivalent = (sub: Subscription): number => {
  switch (sub.billingCycle) {
    case "weekly":
      return (sub.amount * 52) / 12;
    case "monthly":
      return sub.amount;
    case "quarterly":
      return sub.amount / 3;
    case "annual":
      return sub.amount / 12;
  }
};
```

### 2.3 Relationship to existing `Transaction`

Auto-generated subscription transactions are standard `Transaction` objects with:

```ts
{
  id: crypto.randomUUID(),         // fresh each month
  description: subscription.name, // "Netflix"
  amount: subscription.amount,    // amount per billing cycle (full charge, not normalized)
  type: 'debit',                   // subscriptions are always debits
  date: /* billingDay of the month being populated, ISO string */,
  category: subscription.category,
  isRecurring: true,
  recurringId: subscription.id,    // ← links back to the Subscription entity
  paid: false,
  notes: subscription.notes,
  // accountType, accountName, credit card fields: all undefined
}
```

The `recurringId === subscription.id` link is the coupling pin. This means the existing
recurring-management view (`activeView === 'recurring'`) will also surface subscription-
generated transactions in its table. That is acceptable — see §6 edge cases for how to
handle the display.

---

## 3. localStorage Schema Changes

### 3.1 New key

```ts
// Add to App.tsx constants block (near STORAGE_KEY and CATEGORY_STORAGE_KEY):
const SUBSCRIPTIONS_STORAGE_KEY = "cyclebudget_subscriptions";
```

The stored value is `Subscription[]`, serialized as JSON. Initial value is `[]`.

### 3.2 Existing keys — unchanged

`'cyclebudget_data'` and `'cyclebudget_categories'` remain exactly as-is. No migration
of existing data is needed because subscription-generated transactions are new records.

### 3.3 Backup/restore — update the JSON shape

`handleExportJSON` currently produces:

```json
{ "version": 1, "exportedAt": "...", "categories": [...], "transactions": [...] }
```

Bump version and add subscriptions:

```json
{ "version": 2, "exportedAt": "...", "categories": [...], "transactions": [...], "subscriptions": [...] }
```

Update `handleImportJSON` to:

1. Read `backup.subscriptions` if present (missing = `[]` — backwards compatible with v1 files).
2. Add a `sanitizeSubscription(value: unknown): Subscription | null` validator (mirror of
   the existing `sanitizeTransaction`).
3. Call `setSubscriptions(importedSubscriptions)` alongside the existing `setTransactions`
   and `setCategories` calls.

---

## 4. UI — New Views and Existing View Updates

### 4.1 Add `'subscriptions'` to `ViewType`

```ts
// App.tsx line ~11 (currently):
type ViewType =
  | "ledger"
  | "dashboard"
  | "creditCards"
  | "recurring"
  | "categories";

// Change to:
type ViewType =
  | "ledger"
  | "dashboard"
  | "creditCards"
  | "recurring"
  | "subscriptions"
  | "categories";
```

### 4.2 Navigation bar — add Subscriptions button

The nav lives in the `<header>` inside `<App>`. Import `Repeat2` (or `Rss`) from
`lucide-react` — neither is currently imported. `Repeat2` visually communicates
"repeating service" distinctly from `RefreshCw` (used for recurring transactions).

```tsx
// Add after the existing 'recurring' button and before 'categories':
<button
  onClick={() => setActiveView("subscriptions")}
  className={cn(
    "flex items-center gap-2 px-4 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-all",
    activeView === "subscriptions"
      ? "bg-white text-blue-600 shadow-sm"
      : "text-slate-500 hover:text-slate-900",
  )}
>
  <Repeat2 className="w-3.5 h-3.5" />
  Subscriptions
</button>
```

### 4.3 `<main>` conditional — add subscriptions branch

In the large conditional that renders each view, add before the `categories` branch:

```tsx
) : activeView === 'subscriptions' ? (
  <SubscriptionsView
    subscriptions={subscriptions}
    categories={categories}
    onAdd={addSubscription}
    onUpdate={updateSubscription}
    onDelete={deleteSubscription}
    onStatusChange={changeSubscriptionStatus}
  />
) : (
  /* existing categories view */
```

### 4.4 New `SubscriptionsView` component (add to bottom of App.tsx)

Structure mirrors `CreditCardsView` in layout style. Key sections:

**Summary strip (4 stat cards):**
| Card | Value |
|------|-------|
| Monthly Cost | Sum of `getMonthlyEquivalent(sub)` for `status === 'active'` subs |
| Annual Exposure | Monthly Cost × 12 |
| Active Count | count where `status === 'active'` |
| Paused / Cancelled | counts |

**Subscription table (one row per `Subscription`):**

| Column      | Content                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| Service     | Color badge dot + `name` + optional `url` link icon                        |
| Category    | `category` or `--`                                                         |
| Amount      | `$X / mo` (normalized) + raw charge if cycle != monthly, e.g. `$119.99/yr` |
| Cycle       | `Monthly`, `Annual`, etc.                                                  |
| Billing Day | `Day 15`                                                                   |
| Next Charge | Compute from `billingDay` + `billingCycle` + `currentDate`                 |
| Trial Ends  | `trialEndDate` formatted or `--`                                           |
| Status      | Pill badge: green Active / yellow Paused / red Cancelled                   |
| Auto-ledger | Checkbox or toggle showing `autoCreateTransaction`                         |
| Actions     | Edit · Pause/Resume · Cancel · Delete                                      |

**Add/Edit form (inline below table, same footer-panel pattern as the main ledger form):**

Form fields:

- Name (text, required)
- Amount (number, required)
- Billing Cycle (select: Weekly / Monthly / Quarterly / Annual)
- Billing Day (number 1–28, required)
- Category (select, same options as main form)
- Status (select, defaults to 'active')
- Start Date (date)
- Trial End Date (date, optional)
- Auto-create transaction (checkbox, defaults true)
- URL (text, optional)
- Notes (text, optional)
- Color (color picker or preset swatches: 7–8 Tailwind colors)

**Color options** (matching the existing `COLORS` array in App.tsx):
`#2563EB, #7C3AED, #DB2777, #EA580C, #F59E0B, #10B981, #06B6D4, #6366F1`

### 4.5 Dashboard updates

Add two new elements to the existing `activeView === 'dashboard'` section:

**A. New KPI card** (add to the existing 4-card grid, making it 5 or bump to a 3+2 layout):

```
Monthly Subscriptions  |  $XX.XX
                       |  X active services
```

**B. Subscription burn-down section** (add below the existing line chart):

A horizontal stacked bar or sorted list showing subscriptions by cost, normalized to
monthly. This gives the user a "where is my subscription money going" view similar to
the category donut — but specifically for subscription spend.

```
Netflix          ████████████████░░░░  $15.49/mo
Spotify          █████░░░░░░░░░░░░░░░   $9.99/mo
Planet Fitness   ████░░░░░░░░░░░░░░░░   $24.99/mo  (annual — $299.88/yr)
```

Render this as a `<div>` list (not Recharts) for simplicity — one row per active sub,
sorted by normalized monthly cost descending.

### 4.6 `CyclePane` — subscription transaction visual marker

In `CyclePane`'s `<tbody>`, each transaction row currently shows a `RefreshCw` icon
for `t.isRecurring`. Add a second check: if `t.isRecurring && subscriptions.some(s => s.id === t.recurringId)`, render a `Repeat2` icon instead of (or alongside) `RefreshCw`. This visually distinguishes subscription-driven entries from manual recurring entries.

`CyclePane` currently receives no subscriptions prop — add it:

```tsx
// Current signature:
function CyclePane({ title, stats, onEdit, onDelete, onTogglePaid, comparison, headerBg, headerText, borderLeft })

// New signature (add):
function CyclePane({ ..., subscriptions }: { ..., subscriptions: Subscription[] })
```

Pass `subscriptions={subscriptions}` at both `CyclePane` call sites in `<App>`.

### 4.7 `Recurring` view — subscription awareness

The existing `activeView === 'recurring'` view renders a table of all `transactions` where
`isRecurring && recurringId`. Subscription-generated transactions will appear here too (since they set both flags). Add a column or badge that says "via Subscription" when `subscriptions.some(s => s.id === t.recurringId)` — and disable the "Edit Series" button for those rows (directing the user to the Subscriptions view instead).

---

## 5. Implementation Steps (ordered)

### Step 1 — `src/types.ts`: Add new types

Add `BillingCycle`, `SubscriptionStatus`, and `Subscription` as shown in §2.1.
No changes to existing types.

---

### Step 2 — `src/App.tsx`: Imports

Add to the existing lucide-react import block:

```ts
import {
  ...,        // all existing imports
  Repeat2,    // new — for subscription icon
  Globe,      // new — for URL link icon in subscription table (optional)
} from 'lucide-react';
```

Add `Subscription` to the types import:

```ts
import { Transaction, TransactionType, Subscription } from "./types";
```

---

### Step 3 — `src/App.tsx`: Constants

```ts
const SUBSCRIPTIONS_STORAGE_KEY = "cyclebudget_subscriptions";
```

Add this directly below the existing `CATEGORY_STORAGE_KEY` constant.

---

### Step 4 — `src/App.tsx`: Helper functions

Add these near `formatMoney` and `getSavingsRate`:

```ts
const getMonthlyEquivalent = (sub: Subscription): number => {
  switch (sub.billingCycle) {
    case "weekly":
      return (sub.amount * 52) / 12;
    case "monthly":
      return sub.amount;
    case "quarterly":
      return sub.amount / 3;
    case "annual":
      return sub.amount / 12;
  }
};

// Returns the ISO date string for the next billing date of a subscription
// relative to a given reference month.
const getNextBillingDate = (sub: Subscription, referenceDate: Date): string => {
  const day = Math.min(sub.billingDay, 28);
  const candidate = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    day,
  );
  if (candidate < new Date()) {
    // billing day has passed this month — next is next month
    candidate.setMonth(candidate.getMonth() + 1);
  }
  return format(candidate, "yyyy-MM-dd");
};

// Returns true if a subscription should generate a transaction for the given month.
const subscriptionBillsInMonth = (sub: Subscription, month: Date): boolean => {
  if (sub.status !== "active") return false;
  if (!sub.autoCreateTransaction) return false;

  // Check trial: if trial hasn't ended yet, don't charge
  if (sub.trialEndDate && parseISO(sub.trialEndDate) > endOfMonth(month))
    return false;

  // Check start date: subscription must have started on or before this month
  if (parseISO(sub.startDate) > endOfMonth(month)) return false;

  const monthStr = format(month, "yyyy-MM");

  switch (sub.billingCycle) {
    case "weekly":
    case "monthly":
      return true; // bills every month
    case "quarterly": {
      const startMonth = parseISO(sub.startDate).getMonth();
      const viewMonth = month.getMonth();
      return (viewMonth - startMonth + 12) % 3 === 0;
    }
    case "annual": {
      const startMonth = format(parseISO(sub.startDate), "MM");
      return format(month, "MM") === startMonth;
    }
  }
};
```

---

### Step 5 — `src/App.tsx`: ViewType

```ts
// Change:
type ViewType =
  | "ledger"
  | "dashboard"
  | "creditCards"
  | "recurring"
  | "categories";
// To:
type ViewType =
  | "ledger"
  | "dashboard"
  | "creditCards"
  | "recurring"
  | "subscriptions"
  | "categories";
```

---

### Step 6 — `src/App.tsx`: State

Add subscription state inside the `App` component, directly below the `categories` state:

```ts
const [subscriptions, setSubscriptions] = useState<Subscription[]>(() => {
  const saved = localStorage.getItem(SUBSCRIPTIONS_STORAGE_KEY);
  return saved ? JSON.parse(saved) : [];
});
```

Add the persistence `useEffect` directly after the categories persistence effect:

```ts
useEffect(() => {
  localStorage.setItem(
    SUBSCRIPTIONS_STORAGE_KEY,
    JSON.stringify(subscriptions),
  );
}, [subscriptions]);
```

---

### Step 7 — `src/App.tsx`: Subscription auto-injection `useEffect`

This is the most critical and subtle step. Add this useEffect **after** the existing
recurring auto-injection effect (the one keyed on `[currentDate]`):

```ts
useEffect(() => {
  setTransactions((prev) => {
    const activeSubs = subscriptions.filter((sub) =>
      subscriptionBillsInMonth(sub, currentDate),
    );

    if (activeSubs.length === 0) return prev;

    const currentMonthStr = format(currentDate, "yyyy-MM");
    const existingInMonth = prev.filter((t) =>
      t.date.startsWith(currentMonthStr),
    );

    const missingSubTransactions = activeSubs.filter(
      (sub) => !existingInMonth.some((t) => t.recurringId === sub.id),
    );

    if (missingSubTransactions.length === 0) return prev;

    const day = Math.min(sub.billingDay, 28); // computed per sub below
    const newEntries = missingSubTransactions.map((sub) => {
      const billingDay = Math.min(sub.billingDay, 28);
      const targetDate = format(
        new Date(currentDate.getFullYear(), currentDate.getMonth(), billingDay),
        "yyyy-MM-dd",
      );
      return {
        id: crypto.randomUUID(),
        description: sub.name,
        amount: sub.amount,
        type: "debit" as const,
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
}, [currentDate, subscriptions]);
```

⚠️ **Important:** The dependency array includes `subscriptions`. React's StrictMode
double-invokes effects in development — this is fine because `missingSubTransactions`
check prevents duplicate injection. Use the functional updater form (`setTransactions(prev => ...)`)
exactly as the existing recurring effect does, for the same StrictMode safety reason.

---

### Step 8 — `src/App.tsx`: CRUD handlers

Add these handler functions inside `App`, near the existing `deleteTransaction` /
`togglePaid` / `editTransaction` functions:

```ts
const addSubscription = (sub: Omit<Subscription, "id">) => {
  setSubscriptions((prev) => [...prev, { ...sub, id: crypto.randomUUID() }]);
};

const updateSubscription = (updated: Subscription) => {
  setSubscriptions((prev) =>
    prev.map((s) => (s.id === updated.id ? updated : s)),
  );
};

const deleteSubscription = (
  id: string,
  deleteTransactions: boolean = false,
) => {
  setSubscriptions((prev) => prev.filter((s) => s.id !== id));
  if (deleteTransactions) {
    setTransactions((prev) => prev.filter((t) => t.recurringId !== id));
  }
};

const changeSubscriptionStatus = (id: string, status: SubscriptionStatus) => {
  setSubscriptions((prev) =>
    prev.map((s) =>
      s.id === id
        ? {
            ...s,
            status,
            cancelledDate:
              status === "cancelled"
                ? format(new Date(), "yyyy-MM-dd")
                : s.cancelledDate,
          }
        : s,
    ),
  );
};
```

---

### Step 9 — `src/App.tsx`: Header nav button

In the `<nav>` inside `<header>`, add the Subscriptions button between the Recurring
and Categories buttons (see §4.2 for the full JSX).

---

### Step 10 — `src/App.tsx`: Main conditional — subscriptions branch

In the `<main>` element's conditional rendering block (the chain of
`activeView === 'X' ? (...) :` expressions), add the subscriptions branch per §4.3.

---

### Step 11 — `src/App.tsx`: Dashboard updates

Locate the `activeView === 'dashboard'` branch. Specifically:

**A.** Find the 4-item stats array mapped to KPI cards:

```ts
{ label: 'Total Income', ... },
{ label: 'Total Expenses', ... },
{ label: 'Net Cash Flow', ... },
{ label: 'Monthly Burn', ... },
```

Add a 5th item (or restructure to a 5-column grid, or add as a separate row):

```ts
{
  label: 'Subscriptions/mo',
  val: subscriptions
    .filter(s => s.status === 'active')
    .reduce((sum, s) => sum + getMonthlyEquivalent(s), 0),
  color: 'text-violet-600',
  bg: 'bg-violet-50'
}
```

**B.** After the existing `LineChart` section, add the subscription cost breakdown list
(see §4.5.B). Wrap it in:

```tsx
{
  subscriptions.filter((s) => s.status === "active").length > 0 && (
    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
      <h3 className="text-xs uppercase font-bold tracking-widest text-slate-500 mb-6">
        Subscription Costs (Monthly Equivalent)
      </h3>
      {/* sorted cost bars */}
    </div>
  );
}
```

---

### Step 12 — `src/App.tsx`: `CyclePane` subscription awareness

Update `CyclePane` signature and the icon logic per §4.6. Pass `subscriptions` at both
call sites where `CyclePane` is rendered.

---

### Step 13 — `src/App.tsx`: `Recurring` view subscription awareness

In the `activeView === 'recurring'` section's `<tbody>`, add a check:

```ts
const isFromSubscription = subscriptions.some((s) => s.id === rid);
```

Then show a badge and conditionally disable the "Edit Series" button, pointing users
to the Subscriptions view.

---

### Step 14 — `src/App.tsx`: Export/Import updates

**`handleExportJSON`:** Add subscriptions to the backup object:

```ts
const backup = {
  version: 2, // bump from 1
  exportedAt: new Date().toISOString(),
  categories,
  subscriptions, // new
  transactions,
};
```

**`handleImportJSON`:** Add `sanitizeSubscription` validator and read `backup.subscriptions`:

```ts
const sanitizeSubscription = (value: unknown): Subscription | null => {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (
    typeof s.id !== "string" ||
    typeof s.name !== "string" ||
    typeof s.amount !== "number" ||
    !["weekly", "monthly", "quarterly", "annual"].includes(
      s.billingCycle as string,
    ) ||
    typeof s.billingDay !== "number" ||
    !["active", "paused", "cancelled"].includes(s.status as string) ||
    typeof s.startDate !== "string"
  )
    return null;
  return s as unknown as Subscription;
};

// In handleImportJSON, after parsing importedTransactions:
const rawSubs = Array.isArray(backup.subscriptions) ? backup.subscriptions : [];
const importedSubscriptions: Subscription[] = [];
for (const item of rawSubs) {
  const sub = sanitizeSubscription(item);
  if (sub) importedSubscriptions.push(sub);
  // Tolerate bad subscription records (don't reject whole file like transactions do)
}

// Then call:
setSubscriptions(importedSubscriptions);
```

Note the intentional difference: bad subscription records are skipped rather than
rejecting the whole file. This is safer for forwards/backwards compatibility.

---

### Step 15 — `src/App.tsx`: `SubscriptionsView` component

Write the `SubscriptionsView` component at the bottom of `App.tsx` following the same
structural conventions as `CreditCardsView`:

- Props: `{ subscriptions, categories, onAdd, onUpdate, onDelete, onStatusChange }`
- Local state for `editingSub`, form fields
- Render: summary cards → table → inline add/edit form
- The form for adding/editing a subscription is self-contained inside this component
  (unlike the main ledger form which lives in `<App>`'s footer, keep the subscription
  form inline here to avoid polluting App's already-large form state)

---

## 6. Edge Cases and Gotchas

### 6.1 Annual / quarterly subscriptions — don't inject every month

`subscriptionBillsInMonth` handles this with the quarterly modulo check and the annual
month-match check. The critical detail is that the **reference month for quarterly billing
is `sub.startDate`'s month** — not January. A subscription started in March bills in
March, June, September, December. Test this explicitly.

### 6.2 billingDay > 28

Cap at 28 everywhere. Storing `billingDay: 31` for a subscription that started Jan 31
would fail silently in February. The form should enforce `max={28}` and display a note:
"Day 29–31 not supported — use 28 to approximate month-end billing."

### 6.3 StrictMode double-invocation

React StrictMode (enabled in `main.tsx`) double-invokes effects in development. The
existing recurring injection useEffect already handles this correctly by using the
functional updater `setTransactions(prev => ...)` and checking for existing records in
`prev` before appending. The subscription injection effect must do the same — and it
does in the Step 7 code above. Do not use `transactions` directly from closure.

### 6.4 Conflict with existing `isRecurring` / `recurringId` system

Subscription-generated transactions have `isRecurring: true` and `recurringId === subscription.id`.
The existing recurring `useEffect` will see these entries and think they are manual
recurring series — and will try to auto-propagate them by cloning. To prevent this,
**guard the existing recurring useEffect** to skip `recurringId`s that belong to a subscription:

```ts
// In the existing recurring useEffect (the one already in App.tsx):
const subscriptionIds = new Set(subscriptions.map((s) => s.id));

const uniqueRecurringIds = Array.from(
  new Set(
    prev
      .filter(
        (t) =>
          t.isRecurring && t.recurringId && !subscriptionIds.has(t.recurringId),
      ) // ← add this guard
      .map((t) => t.recurringId!),
  ),
);
```

Without this guard, both effects will compete to inject the same month's transaction,
and the existing effect will also create unwanted copies if a subscription transaction
exists in a prior month.

### 6.5 Deleting a subscription vs. its transactions

`deleteSubscription(id, deleteTransactions: boolean)` should prompt the user:

- "Remove subscription only" — keeps historical ledger entries (good for "I cancelled
  but want to keep my spending history")
- "Remove subscription and all associated transactions" — cascade delete via
  `setTransactions(prev => prev.filter(t => t.recurringId !== id))`

The `CreditCardsView` and recurring view already have similar cascade-vs-single patterns.

### 6.6 Pausing a subscription mid-month

If a user pauses a subscription after its transaction has already been auto-injected for
the current month, the transaction stays in the ledger. This is correct — the charge
may already have occurred. No special handling needed.

### 6.7 Trial end dates

If `trialEndDate` is set and is in the future, `subscriptionBillsInMonth` returns false.
Once the trial month passes, the next `currentDate` navigation triggers injection for
that month. But if the user has been viewing ahead (navigating to a future month), they
may see a trial-period subscription appear in the ledger. Consider showing a "Trial"
badge in the Subscriptions table for subscriptions where `trialEndDate > today`.

### 6.8 `activeView` nav bar width

The nav already has 5 buttons. Adding a 6th ("Subscriptions") makes it 6. On narrower
viewports this will overflow. The header uses `flex-wrap` so it will reflow — test at
1280px. If needed, abbreviate to "Subs" or use icon-only at smaller breakpoints.

### 6.9 Backup version bump — don't break v1 imports

`handleImportJSON` currently does a hard reject if `getTransactionsFromBackup` returns
null. The version 2 format adds `subscriptions` as an optional field. Since v1 files
have no `subscriptions` key, the import should treat `backup.subscriptions === undefined`
as `[]` (an empty array), not as a validation error. The Step 14 code above handles this
correctly with `Array.isArray(backup.subscriptions) ? backup.subscriptions : []`.

### 6.10 The `CycleBudget` type in `types.ts` is unused

`CycleBudget` and `PaymentCycle` are defined in `types.ts` but never imported or used
anywhere in `App.tsx`. Don't remove them (not your scope), but don't reference them in
the subscription system either — they're dead code from an earlier refactor.

### 6.11 Weekly subscriptions and the split-cycle view

A weekly subscription (e.g., a weekly meal kit service) billed 4–5 times per month
creates only **one** auto-injected transaction per month in the current model (one per
`billingDay`). This is a simplification. For true weekly injection you'd need to
generate 4 or 5 transactions per month. Consider: either (a) document this limitation
and treat weekly as "monthly equivalent for budgeting purposes," or (b) generate
multiple transactions. Option (a) is strongly recommended for v1 — weekly subscriptions
are rare, and generating multiple auto-entries creates significant complexity in the
delete/edit/pause flows.

---

## Summary Table

| Area           | Files Changed  | What Changes                                                                              |
| -------------- | -------------- | ----------------------------------------------------------------------------------------- |
| Types          | `src/types.ts` | Add `BillingCycle`, `SubscriptionStatus`, `Subscription`                                  |
| Constants      | `src/App.tsx`  | Add `SUBSCRIPTIONS_STORAGE_KEY`                                                           |
| ViewType       | `src/App.tsx`  | Add `'subscriptions'` to union                                                            |
| State          | `src/App.tsx`  | Add `subscriptions` useState + localStorage effect                                        |
| Helper fns     | `src/App.tsx`  | `getMonthlyEquivalent`, `getNextBillingDate`, `subscriptionBillsInMonth`                  |
| Auto-injection | `src/App.tsx`  | New useEffect; guard existing recurring useEffect                                         |
| CRUD           | `src/App.tsx`  | `addSubscription`, `updateSubscription`, `deleteSubscription`, `changeSubscriptionStatus` |
| Nav            | `src/App.tsx`  | Add Subscriptions button in `<header>` nav                                                |
| Dashboard      | `src/App.tsx`  | New KPI card + subscription cost breakdown section                                        |
| Ledger         | `src/App.tsx`  | `CyclePane` gets `subscriptions` prop; `Repeat2` icon on sub transactions                 |
| Recurring view | `src/App.tsx`  | Badge + disabled edit for subscription-generated rows                                     |
| New view       | `src/App.tsx`  | `SubscriptionsView` component                                                             |
| Backup         | `src/App.tsx`  | `handleExportJSON` v2 shape; `handleImportJSON` reads subscriptions                       |
| Imports        | `src/App.tsx`  | Add `Repeat2`, `Globe` from lucide-react; `Subscription` from `./types`                   |
