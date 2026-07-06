# BudgetEaze — Credit Card Dashboard Feature Spec

**Repo:** https://github.com/HowAI-1811/budgeteaze.git  
**Stack:** React + TypeScript + Vite  
**Styling:** CSS (index.css)  
**Data persistence:** JSON backup/restore (no Supabase, no backend)  
**Backup version to target:** `version: 2` (current is `version: 1`)

---

## Context

BudgetEaze is a personal budget app. Data lives entirely in memory and is persisted via a manual Backup button that exports a JSON file, and an Import button that restores it.

Credit cards currently appear in the app only as **recurring bill payment transactions** under the `Credit Cards` category (e.g. "Chase Disney $400/mo"). These represent the monthly payment made via external bill pay — the user never initiates payments from within the app.

This feature adds a **Credit Card Dashboard** that tracks what is *on* each card — balance, subscriptions, and ad hoc charges — separately from the bill payment transactions already in the budget.

---

## What Already Exists

- `transactions[]` — all budget transactions including credit card payments
- `categories[]` — includes `"Credit Cards"`, `"Software"`, `"Entertainment"`, etc.
- `isRecurring: true` flag on transactions — identifies recurring items
- A **Subscription Management** view already exists in the app (`src/` — exact filename visible in repo)
- Existing credit cards tracked as recurring transactions:
  - Credit One
  - Discover Card
  - Chase Slate
  - HSN
  - Chase Disney

---

## JSON Schema Changes (version 1 → version 2)

Add two new top-level arrays. **Do not modify the existing `transactions` array structure.**

```ts
// types.ts additions

export interface CreditCard {
  id: string;                  // uuid
  name: string;                // e.g. "Chase Disney"
  last4: string;               // last 4 digits
  network: string;             // "Visa" | "Mastercard" | "Amex" | "Discover"
  limit: number;               // credit limit
  balance: number;             // current balance (manually maintained)
  minDue: number;              // minimum payment due
  dueDate: string;             // ISO date string, e.g. "2026-06-15"
  stmtCloseDate: string;       // ISO date string
  apr?: number;                // optional
  color?: string;              // optional hex for card visual
}

export interface CardSubscription {
  id: string;                  // uuid
  cardId: string;              // FK → CreditCard.id
  name: string;                // e.g. "Adobe Creative Cloud"
  amount: number;
  billingDay: number;          // day of month (1–31)
  category: string;            // maps to existing categories[]
  status: "active" | "paused" | "cancelled";
}

export interface CardTransaction {
  id: string;                  // uuid
  cardId: string;              // FK → CreditCard.id
  description: string;
  amount: number;
  date: string;                // ISO date string
  category: string;            // maps to existing categories[]
  posted: boolean;             // true = confirmed charge, false = pending
  notes?: string;
}
```

### Updated backup shape

```json
{
  "version": 2,
  "exportedAt": "...",
  "categories": [...],
  "transactions": [...],
  "creditCards": [],
  "cardSubscriptions": [],
  "cardTransactions": []
}
```

---

## Backup Version Migration

When the app loads a backup, check `version`:

```ts
function migrateBackup(data: any) {
  if (data.version === 1) {
    return {
      ...data,
      version: 2,
      creditCards: [],
      cardSubscriptions: [],
      cardTransactions: [],
    };
  }
  return data;
}
```

This is non-destructive — existing `transactions` are untouched.

---

## Subscription Management Changes

The existing subscription UI needs **one new field**: the card selector.

### Add to subscription entry form

```
Card:  [ Select a card ▾ ]   ← new dropdown, populated from creditCards[]
```

- `cardId` is stored on the `CardSubscription` record
- If no credit cards have been added yet, show: *"Add a credit card first"* with a link to the Credit Card Dashboard
- Subscriptions with a `cardId` will appear on the relevant card's dashboard
- Subscriptions **without** a `cardId` (e.g. bank auto-pay subs) remain in the main subscription list only

### Existing recurring transactions that are subscriptions

Items like Adobe ($23) and Apple ($110) currently exist as `isRecurring: true` transactions. When the user sets them up as `CardSubscriptions`, the corresponding recurring transaction should be **removed** to avoid double-counting. The card's monthly payment transaction in the budget already covers the total.

**Migration approach:** Do not auto-migrate. Let the user re-enter subscriptions in the new Subscription Management form with a card selected. Provide a note in the UI: *"Tip: If you've added a subscription here, remove it from your recurring transactions to avoid duplication."*

---

## Credit Card Dashboard — Features

### 1. Card selector
- Pill-style tabs at the top
- One tab per card in `creditCards[]`
- "+ Add Card" pill opens the add card modal

### 2. Card visual
- Styled card showing: nickname, last 4, network, cardholder name, statement close date
- Dark gradient background (use `color` field or default gradient)

### 3. Stats row (3 columns)
- **Balance** — `card.balance` (red)
- **Available** — `card.limit - card.balance` (green)
- **Min Due** — `card.minDue` (amber)

### 4. Utilization bar
- `(balance / limit) * 100`
- Gradient fill, percentage label
- Shows limit below bar

### 5. Due date banner
- Shows `card.dueDate`
- Calculates days until due from today
- Highlighted in red when ≤ 7 days

### 6. Subscriptions this cycle
- Query: `cardSubscriptions.filter(s => s.cardId === card.id && s.status === 'active')`
- For each sub, show: name, amount, billing day, posted/upcoming status
- **Posted** = billingDay has passed in the current calendar month
- **Upcoming** = billingDay is in the future this month
- Show monthly subscription total for this card
- "Manage Subscriptions" link → existing Subscription Management view

### 7. Ad hoc charges
- Query: `cardTransactions.filter(t => t.cardId === card.id)` for current cycle
- Show recent transactions: description, amount, date, category
- "+ Log Charge" button → inline form or modal

### 8. Balance calculation (derived, not stored separately)
```
Displayed Balance = card.balance
(user manually updates via "Update Balance" or it's recalculated from logged payments)
```

Keep balance as a manually-maintained field for now. Future enhancement: auto-calculate from transactions.

### 9. Log a Payment button
- Records a payment against the card
- Reduces `card.balance` by the payment amount
- Does NOT create a budget transaction (user handles that via bill pay externally)
- Saves a record in `cardTransactions` with a `"Payment"` description and negative amount

---

## UI Flows

### Add a Card
Modal with fields: Name, Last 4, Network (dropdown), Credit Limit, Current Balance, Min Due, Due Date, Statement Close Date, APR (optional)

### Log a Charge
Modal or inline form: Description, Amount, Date (default today), Category (dropdown from existing categories[]), Posted toggle

### Update Balance
Simple inline edit on the balance stat — allows manual correction

### Log a Payment
Modal: Amount (pre-filled with minDue), Date (default today) → updates `card.balance`

---

## Component Structure (suggested)

```
src/
  components/
    CreditCards/
      CreditCardDashboard.tsx    ← main view, card selector + content
      CreditCardVisual.tsx       ← the card graphic
      CardStats.tsx              ← balance / available / min due row
      UtilizationBar.tsx
      DueDateBanner.tsx
      CardSubscriptions.tsx      ← subscriptions panel
      CardTransactions.tsx       ← ad hoc charges list
      AddCardModal.tsx
      LogChargeModal.tsx
      LogPaymentModal.tsx
```

---

## Design Notes

- Match existing BudgetEaze UI style and color scheme
- Dark theme if the app uses one; match whatever is in `index.css`
- Use existing category list (`categories[]`) for all category dropdowns — do not hardcode
- All monetary values formatted as USD currency
- Dates displayed in human-readable format (e.g. "Jun 15" not ISO string)

---

## Out of Scope (for this build)

- Bank/card sync (no Plaid or API connections)
- Payment initiation (user pays externally via bill pay)
- Rewards/cashback tracking
- Credit score impact indicators
- Multi-currency support

---

## Files to Review Before Building

- `src/types.ts` — add new interfaces here
- `src/App.tsx` — add new state for `creditCards`, `cardSubscriptions`, `cardTransactions`; include in backup export/import
- Existing Subscription Management component — add `cardId` field to form and data model
- Backup export function — bump version to 2, include new arrays
- Backup import function — add `migrateBackup()` call on load
