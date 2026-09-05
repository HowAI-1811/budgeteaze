import React, { useState } from 'react';
import { format } from 'date-fns';
import { bankBalance, bankCashFlow, sanitizeBankAccount, sanitizeBankTransaction, type BankAccount, type BankTransaction } from './lib/banking';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const field = 'w-full rounded-md border border-slate-300 bg-white p-2 text-sm';
const button = 'rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40';

export default function Banking({ accounts, transactions, categories, onAccounts, onTransactions }: {
  accounts: BankAccount[]; transactions: BankTransaction[]; categories: string[];
  onAccounts: (value: BankAccount[]) => void; onTransactions: (value: BankTransaction[]) => void;
}) {
  const live = accounts.filter(a => !a.deletedAt);
  const [selectedId, setSelectedId] = useState('');
  const selected = live.find(a => a.id === selectedId) ?? live[0];
  const [accountForm, setAccountForm] = useState<Partial<BankAccount> | null>(null);
  const [transactionForm, setTransactionForm] = useState<Partial<BankTransaction> | null>(null);
  const [error, setError] = useState('');
  const visible = transactions.filter(t => !t.deletedAt && (t.accountId === selected?.id || t.destinationId === selected?.id)).sort((a, b) => b.date.localeCompare(a.date));
  const flow = bankCashFlow(transactions);
  const accountName = (id?: string) => accounts.find(a => a.id === id)?.name ?? 'Unknown account';
  const close = () => { setAccountForm(null); setTransactionForm(null); setError(''); };
  return <div className="h-full overflow-y-auto p-4 md:p-8 space-y-6">
    <div className="flex items-center justify-between gap-4"><div><h2 className="font-serif italic text-3xl">Banking</h2><p className="text-sm text-slate-500">Checking and savings · balances include all recorded activity.</p></div><button className={button} onClick={() => { close(); setAccountForm({ type: 'checking', startingBalance: 0 }); }}>Add account</button></div>
    <div className="grid gap-4 sm:grid-cols-3">{[['Total cash', live.reduce((n, a) => n + bankBalance(a, transactions), 0)], ['Money in · all time', flow.income], ['Money out · all time', flow.expenses]].map(([label, value]) => <div key={label} className="bg-white border border-slate-200 rounded-xl p-5"><p className="text-xs text-slate-500">{label}</p><p className="font-mono text-2xl mt-2">{money(Number(value))}</p></div>)}</div>
    <p className="text-xs text-slate-500">Transfers are excluded from money in/out. Banking activity is tracked separately from the budget ledger.</p>
    {!live.length ? <div className="bg-white rounded-xl border p-10 text-center text-slate-500">Add your checking or savings account to start tracking money in and out.</div> : <>
      <div className="flex flex-wrap gap-3">{live.map(a => <button key={a.id} onClick={() => { setSelectedId(a.id); close(); }} className={`text-left rounded-xl border p-4 min-w-48 ${a.id === selected.id ? 'border-blue-600 bg-blue-50' : 'bg-white border-slate-200'}`}><p className="font-semibold">{a.name}</p><p className="capitalize text-xs text-slate-500">{a.type}</p><p className="font-mono mt-2">{money(bankBalance(a, transactions))}</p></button>)}</div>
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{selected.name} transactions</h3><div className="flex gap-3"><button className="text-sm text-blue-600" onClick={() => { close(); setAccountForm(selected); }}>Edit account</button><button className={button} onClick={() => { close(); setTransactionForm({ accountId: selected.id, type: 'out', date: format(new Date(), 'yyyy-MM-dd'), category: '', notes: '' }); }}>Add transaction</button></div></div>
      {!visible.length ? <p className="text-sm text-slate-500 py-6">No transactions yet. Your balance starts at {money(selected.startingBalance)}.</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500 border-b">{['Date', 'Description', 'Category', 'Amount', 'Actions'].map(h => <th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{visible.map(t => <tr key={t.id} className="border-b border-slate-100"><td className="p-3 whitespace-nowrap">{t.date}</td><td className="p-3">{t.description}{t.type === 'transfer' && <p className="text-xs text-slate-500">{accountName(t.accountId)} → {accountName(t.destinationId)}</p>}{t.notes && <p className="text-xs text-slate-500">{t.notes}</p>}</td><td className="p-3">{t.type === 'transfer' ? 'Transfer' : t.category || '—'}</td><td className="p-3 font-mono whitespace-nowrap">{t.type === 'in' || t.destinationId === selected.id ? '+' : '−'}{money(t.amount)}</td><td className="p-3 whitespace-nowrap"><button className="text-blue-600 mr-3" onClick={() => { close(); setTransactionForm(t); }}>Edit</button><button className="text-red-600" onClick={() => { if (confirm(t.type === 'transfer' ? 'Delete this transfer? Both account balances will be updated.' : 'Delete this transaction?')) { const ts = new Date().toISOString(); onTransactions(transactions.map(row => row.id === t.id ? { ...row, deletedAt: ts, updatedAt: ts } : row)); } }}>Delete</button></td></tr>)}</tbody></table></div>}</div>
    </>}
    {(accountForm || transactionForm) && <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"><div role="dialog" aria-modal="true" aria-label={accountForm ? 'Account details' : 'Transaction details'} className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"><h3 className="text-xl font-semibold mb-4">{accountForm ? 'Account details' : 'Transaction details'}</h3>
      <form className="space-y-4" onSubmit={e => {
        e.preventDefault(); const ts = new Date().toISOString();
        if (accountForm) {
          const a = sanitizeBankAccount({ ...accountForm, id: accountForm.id ?? crypto.randomUUID(), createdAt: accountForm.createdAt ?? ts, updatedAt: ts });
          if (!a) { setError('Enter an account name and a valid starting balance.'); return; }
          onAccounts(accountForm.id ? accounts.map(row => row.id === a.id ? a : row) : [...accounts, a]); setSelectedId(a.id);
        } else if (transactionForm) {
          const t = sanitizeBankTransaction({ ...transactionForm, id: transactionForm.id ?? crypto.randomUUID(), createdAt: transactionForm.createdAt ?? ts, updatedAt: ts });
          if (!t || !live.some(a => a.id === t.accountId) || (t.type === 'transfer' && !live.some(a => a.id === t.destinationId))) { setError('Enter a description, positive amount, date, and distinct accounts for a transfer.'); return; }
          onTransactions(transactionForm.id ? transactions.map(row => row.id === t.id ? t : row) : [...transactions, t]);
        } close();
      }}>
        {accountForm ? <>
          <label className="block text-sm">Account name<input autoFocus required className={field} value={accountForm.name ?? ''} onChange={e => setAccountForm({ ...accountForm, name: e.target.value })} /></label>
          <label className="block text-sm">Account type<select className={field} value={accountForm.type} onChange={e => setAccountForm({ ...accountForm, type: e.target.value as BankAccount['type'] })}><option value="checking">Checking</option><option value="savings">Savings</option></select></label>
          <label className="block text-sm">Starting balance<input required type="number" step="0.01" className={field} value={accountForm.startingBalance ?? ''} onChange={e => setAccountForm({ ...accountForm, startingBalance: e.target.value === '' ? undefined : Number(e.target.value) })} /></label><p className="text-xs text-slate-500">Balance before the transactions you record here. Changing it adjusts your current balance.</p>
        </> : transactionForm && <>
          <label className="block text-sm">Activity<select className={field} value={transactionForm.type} onChange={e => setTransactionForm({ ...transactionForm, type: e.target.value as BankTransaction['type'] })}><option value="out">Money out</option><option value="in">Money in</option><option value="transfer" disabled={live.length < 2}>Transfer between accounts</option></select></label>
          <label className="block text-sm">{transactionForm.type === 'transfer' ? 'From account' : 'Account'}<select className={field} value={transactionForm.accountId} onChange={e => setTransactionForm({ ...transactionForm, accountId: e.target.value })}>{live.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          {transactionForm.type === 'transfer' && <label className="block text-sm">To account<select required className={field} value={transactionForm.destinationId ?? ''} onChange={e => setTransactionForm({ ...transactionForm, destinationId: e.target.value })}><option value="">Choose account</option>{live.filter(a => a.id !== transactionForm.accountId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
          <label className="block text-sm">Description<input required className={field} placeholder="Groceries, paycheck, interest earned…" value={transactionForm.description ?? ''} onChange={e => setTransactionForm({ ...transactionForm, description: e.target.value })} /></label>
          <div className="grid grid-cols-2 gap-3"><label className="block text-sm">Amount<input required type="number" min="0.01" step="0.01" className={field} value={transactionForm.amount ?? ''} onChange={e => setTransactionForm({ ...transactionForm, amount: Number(e.target.value) })} /></label><label className="block text-sm">Date<input required type="date" className={field} value={transactionForm.date} onChange={e => setTransactionForm({ ...transactionForm, date: e.target.value })} /></label></div>
          {transactionForm.type !== 'transfer' && <label className="block text-sm">Category<input list="bank-categories" className={field} value={transactionForm.category ?? ''} onChange={e => setTransactionForm({ ...transactionForm, category: e.target.value })} /><datalist id="bank-categories">{Array.from(new Set([...categories, 'Interest earned'])).map(c => <option key={c} value={c} />)}</datalist></label>}
          <label className="block text-sm">Notes<textarea className={field} value={transactionForm.notes ?? ''} onChange={e => setTransactionForm({ ...transactionForm, notes: e.target.value })} /></label>
        </>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}<div className="flex justify-end gap-4"><button type="button" onClick={close}>Cancel</button><button className={button}>Save</button></div>
      </form></div></div>}
  </div>;
}
