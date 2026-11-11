import { mongoose } from 'db/connection'
import { BankAccount, BankReconciliation, JournalEntry, POSTED_BOOKS } from 'db/models'
import type { StatementLine } from './statement-csv.js'

/**
 * #675 — bank reconciliation: the bank's statement against the ledger, for one bank account.
 *
 * - **The bank side** is the lines of the account's draft reconciliation (one draft per bank account at a time):
 *   imported from a statement file (`statement-csv.ts`), or entered by hand where there is none. Both, in one list.
 * - **The ledger side** is every posted journal line on the bank account's ledger account (`BankAccount.accountId`) up
 *   to the statement date that no COMPLETED reconciliation of this account has matched: what was left outstanding
 *   last time carries forward. A journal line has no id of its own, so it is named `<journalEntryId>:<line>`.
 * - **Matching** puts bank lines and ledger lines together when their amounts agree to the cent.
 * - **Completing** takes the statement's balance and refuses unless the reconciliation balances:
 *     (statement balance − ledger lines not on the statement) − (book balance + bank lines not in the ledger) = 0.
 *
 * Amounts are signed: + money in, − money out. A stored bank line keeps its amount positive and its `type`
 * (`deposit` / `withdrawal`), as the model has always held it.
 */

export class ReconciliationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

const cents = (n: number) => Math.round(n * 100)
const round2 = (n: number) => Math.round(n * 100) / 100
const ymd = (d: Date | string) => new Date(d).toISOString().slice(0, 10)
const endOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999))
const signed = (item: { amount: number; type?: string }) => (item.type === 'withdrawal' ? -Math.abs(item.amount) : Math.abs(item.amount))
const oid = (id: unknown) => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null)

/** A date as the caller gave it (`yyyy-mm-dd` or a Date), else today. */
function dayOf(value: unknown): Date {
  const d = value ? new Date(String(value).slice(0, 10)) : new Date()
  if (Number.isNaN(d.getTime())) throw new ReconciliationError(422, 'date_invalid', `Not a date: ${String(value)}`)
  return d
}

async function bankAccountOf(orgId: string, bankAccountId: string) {
  const id = oid(bankAccountId)
  const bank: any = id ? await BankAccount.findOne({ _id: id, orgId }).lean().exec() : null
  if (!bank) throw new ReconciliationError(404, 'bank_account_not_found', 'Bank account not found')
  return bank
}

async function draftOf(orgId: string, bankAccountId: string, create: { statementDate: Date } | null = null) {
  let draft = await BankReconciliation.findOne({ orgId, bankAccountId, status: 'draft' }).exec()
  if (!draft && create) {
    draft = await BankReconciliation.create({
      orgId, bankAccountId, statementDate: create.statementDate, statementBalance: 0, bookBalance: 0, difference: 0,
      status: 'draft', items: [], matches: [],
    })
  }
  return draft
}

interface LedgerLine { id: string; journalEntryId: string; line: number; date: Date; description: string; reference?: string; amount: number }

/** Every posted journal line on the ledger account up to the date: what the book balance is the sum of. */
async function ledgerLines(orgId: string, glAccountId: unknown, until: Date): Promise<LedgerLine[]> {
  const entries: any[] = await JournalEntry.find(
    { orgId, ...POSTED_BOOKS, date: { $lte: until }, 'lines.accountId': glAccountId },
    { entryNumber: 1, date: 1, description: 1, reference: 1, lines: 1 },
  ).sort({ date: 1, entryNumber: 1 }).lean().exec()
  const out: LedgerLine[] = []
  for (const e of entries) {
    ;(e.lines || []).forEach((l: any, i: number) => {
      if (String(l.accountId) !== String(glAccountId)) return
      out.push({
        id: `${e._id}:${i}`, journalEntryId: String(e._id), line: i, date: e.date,
        description: l.description || e.description || e.entryNumber, reference: e.reference || e.entryNumber,
        amount: round2((l.debit || 0) - (l.credit || 0)),
      })
    })
  }
  return out
}

/** The ledger lines completed reconciliations of this account have matched: they are done with. */
async function settledLedger(orgId: string, bankAccountId: string): Promise<Set<string>> {
  const done: any[] = await BankReconciliation.find({ orgId, bankAccountId, status: 'completed' }, { matches: 1 }).lean().exec()
  return new Set(done.flatMap(r => (r.matches || []).flatMap((m: any) => (m.ledger || []).map((l: any) => `${l.journalEntryId}:${l.line}`))))
}

const matchedLedgerOf = (draft: any) =>
  new Set<string>((draft?.matches || []).flatMap((m: any) => (m.ledger || []).map((l: any) => `${l.journalEntryId}:${l.line}`)))

export interface ReconciliationView {
  reconciliationId: string | null
  statementDate: string | null
  statementBalance: number | null
  bookBalance: number
  bankTransactions: Array<{ _id: string; date: string; description: string; amount: number; bankReference?: string; source?: string; matched: boolean }>
  ledgerTransactions: Array<{ _id: string; date: string; description: string; reference?: string; amount: number; matched: boolean }>
}

/** Both sides, for the screen: the draft's bank lines and the ledger lines still open, with the book balance. */
export async function reconciliationView(orgId: string, bankAccountId: string, date?: unknown): Promise<ReconciliationView> {
  const bank = await bankAccountOf(orgId, bankAccountId)
  const draft: any = await draftOf(orgId, bankAccountId)
  const until = endOfDay(dayOf(date))
  const lines = await ledgerLines(orgId, bank.accountId, until)
  const settled = await settledLedger(orgId, bankAccountId)
  const inDraft = matchedLedgerOf(draft)
  return {
    reconciliationId: draft ? String(draft._id) : null,
    statementDate: draft ? ymd(draft.statementDate) : null,
    statementBalance: draft ? draft.statementBalance : null,
    bookBalance: round2(lines.reduce((s, l) => s + l.amount, 0)),
    bankTransactions: (draft?.items || []).map((it: any) => ({
      _id: String(it._id), date: new Date(it.date).toISOString(), description: it.description, amount: signed(it),
      ...(it.bankReference ? { bankReference: it.bankReference } : {}), ...(it.source ? { source: it.source } : {}), matched: !!it.matched,
    })),
    ledgerTransactions: lines.filter(l => !settled.has(l.id)).map(l => ({
      _id: l.id, date: new Date(l.date).toISOString(), description: l.description, reference: l.reference, amount: l.amount, matched: inDraft.has(l.id),
    })),
  }
}

const keyOf = (date: Date | string, amount: number, reference?: string, description?: string) =>
  `${ymd(date)}|${cents(amount)}|${(reference || '').trim()}|${reference ? '' : (description || '').trim().toLowerCase()}`

/**
 * Add statement lines to the account's draft (made if there is none). An import skips a line the draft already holds
 * (same day, amount and reference, or description where there is no reference), so a statement imported twice adds
 * nothing; lines a person enters are always added (two equal fees on one day are two lines).
 */
export async function addStatementLines(
  orgId: string, bankAccountId: string, lines: StatementLine[],
  opts: { statementDate?: unknown; source: 'import' | 'manual' },
): Promise<{ added: number; skipped: number; reconciliationId: string }> {
  await bankAccountOf(orgId, bankAccountId)
  const draft: any = await draftOf(orgId, bankAccountId, { statementDate: dayOf(opts.statementDate) })
  const seen = new Set<string>((draft.items || []).map((it: any) => keyOf(it.date, signed(it), it.bankReference, it.description)))
  let added = 0
  let skipped = 0
  for (const l of lines) {
    const amount = round2(Number(l.amount))
    if (!amount || !l.date || Number.isNaN(new Date(l.date).getTime())) throw new ReconciliationError(422, 'line_invalid', 'A line needs a date and an amount other than 0')
    const key = keyOf(l.date, amount, l.bankReference, l.description)
    if (opts.source === 'import' && seen.has(key)) { skipped++; continue }
    seen.add(key)
    draft.items.push({
      date: new Date(l.date), description: String(l.description || '—').slice(0, 500), amount: Math.abs(amount),
      type: amount < 0 ? 'withdrawal' : 'deposit', matched: false, source: opts.source,
      ...(l.bankReference ? { bankReference: String(l.bankReference).slice(0, 200) } : {}),
    })
    added++
  }
  if (added) await draft.save()
  return { added, skipped, reconciliationId: String(draft._id) }
}

/** Remove a bank line not yet matched. */
export async function removeStatementLine(orgId: string, bankAccountId: string, lineId: string): Promise<void> {
  await bankAccountOf(orgId, bankAccountId)
  const draft: any = await draftOf(orgId, bankAccountId)
  const item = mongoose.isValidObjectId(lineId) ? draft?.items?.id?.(lineId) : null
  if (!item) throw new ReconciliationError(404, 'line_not_found', 'No such line on this account\'s open reconciliation')
  if (item.matched) throw new ReconciliationError(409, 'line_matched', 'The line is matched: unmatch it first')
  item.deleteOne()
  await draft.save()
}

/** Match bank lines with ledger lines whose amounts agree to the cent. */
export async function matchLines(orgId: string, bankAccountId: string, bankIds: string[], ledgerIds: string[]): Promise<void> {
  const bank = await bankAccountOf(orgId, bankAccountId)
  if (!bankIds?.length || !ledgerIds?.length) throw new ReconciliationError(422, 'match_needs_both', 'Choose at least one bank line and one ledger line')
  const draft: any = await draftOf(orgId, bankAccountId)
  if (!draft) throw new ReconciliationError(404, 'no_open_reconciliation', 'This account has no open reconciliation: add or import its statement lines first')
  const items = bankIds.map(id => (mongoose.isValidObjectId(id) ? draft.items.id(id) : null))
  if (items.some((it: any) => !it)) throw new ReconciliationError(422, 'line_not_found', 'A bank line is not on this account\'s open reconciliation')
  if (items.some((it: any) => it.matched)) throw new ReconciliationError(409, 'line_matched', 'A bank line is already matched')

  const settled = await settledLedger(orgId, bankAccountId)
  const inDraft = matchedLedgerOf(draft)
  const refs: Array<{ journalEntryId: any; line: number; amount: number }> = []
  for (const id of new Set(ledgerIds)) {
    const [entryId, lineText] = String(id).split(':')
    const line = Number(lineText)
    const entryOid = oid(entryId)
    const entry: any = entryOid && Number.isInteger(line)
      ? await JournalEntry.findOne({ _id: entryOid, orgId, ...POSTED_BOOKS }, { lines: 1 }).lean().exec()
      : null
    const l = entry?.lines?.[line]
    if (!l || String(l.accountId) !== String(bank.accountId)) throw new ReconciliationError(422, 'ledger_line_not_found', `Not a posted line on this account's ledger account: ${id}`)
    if (settled.has(`${entryId}:${line}`) || inDraft.has(`${entryId}:${line}`)) throw new ReconciliationError(409, 'ledger_line_matched', `The ledger line is already matched: ${id}`)
    refs.push({ journalEntryId: entryOid, line, amount: round2((l.debit || 0) - (l.credit || 0)) })
  }
  const bankSum = round2(items.reduce((s: number, it: any) => s + signed(it), 0))
  const ledgerSum = round2(refs.reduce((s, r) => s + r.amount, 0))
  if (cents(bankSum) !== cents(ledgerSum)) {
    throw new ReconciliationError(422, 'amounts_differ', `The bank lines come to ${bankSum.toFixed(2)} and the ledger lines to ${ledgerSum.toFixed(2)}`, { bank: bankSum, ledger: ledgerSum })
  }
  draft.matches.push({ bankItemIds: items.map((it: any) => it._id), ledger: refs.map(r => ({ journalEntryId: r.journalEntryId, line: r.line })) })
  for (const it of items) it.matched = true
  await draft.save()
}

/** Undo the matches these bank lines are in. */
export async function unmatchLines(orgId: string, bankAccountId: string, bankIds: string[]): Promise<void> {
  await bankAccountOf(orgId, bankAccountId)
  const draft: any = await draftOf(orgId, bankAccountId)
  if (!draft) throw new ReconciliationError(404, 'no_open_reconciliation', 'This account has no open reconciliation')
  const wanted = new Set((bankIds || []).map(String))
  const undone = draft.matches.filter((m: any) => m.bankItemIds.some((id: any) => wanted.has(String(id))))
  if (!undone.length) throw new ReconciliationError(404, 'match_not_found', 'None of these lines is matched')
  const freed = new Set(undone.flatMap((m: any) => m.bankItemIds.map(String)))
  for (const m of undone) m.deleteOne()
  for (const it of draft.items) if (freed.has(String(it._id))) it.matched = false
  await draft.save()
}

/** Complete the open reconciliation at the statement's balance: refused unless it balances to the cent. */
export async function completeReconciliation(
  orgId: string, bankAccountId: string, statementDate: unknown, statementBalance: number, userId: string,
): Promise<{ reconciliationId: string; bookBalance: number }> {
  await bankAccountOf(orgId, bankAccountId)
  const draft: any = await draftOf(orgId, bankAccountId)
  if (!draft) throw new ReconciliationError(404, 'no_open_reconciliation', 'This account has no open reconciliation')
  const view = await reconciliationView(orgId, bankAccountId, statementDate)
  const openLedger = view.ledgerTransactions.filter(t => !t.matched).reduce((s, t) => s + t.amount, 0)
  const openBank = view.bankTransactions.filter(t => !t.matched).reduce((s, t) => s + t.amount, 0)
  const difference = round2((Number(statementBalance) - openLedger) - (view.bookBalance + openBank))
  if (cents(difference) !== 0) {
    throw new ReconciliationError(409, 'difference_not_zero', `The reconciliation does not balance: a difference of ${difference.toFixed(2)}`, { difference })
  }
  Object.assign(draft, {
    statementDate: dayOf(statementDate), statementBalance: round2(Number(statementBalance)), bookBalance: view.bookBalance,
    difference: 0, status: 'completed', reconciledBy: oid(userId) ?? undefined, reconciledAt: new Date(),
  })
  await draft.save()
  return { reconciliationId: String(draft._id), bookBalance: view.bookBalance }
}
