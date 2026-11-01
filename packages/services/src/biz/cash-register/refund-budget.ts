/**
 * FR-23 §2.5 — what a fiscal receipt still holds, and the one place that takes from it.
 *
 * A receipt printed its money per VAT rate, and whatever reverses it takes from that: today a refund
 * on a credit note (`payment_storno`), citing a `payment_receipt` or, for an invoice issued for a till
 * sale (R0), that sale's own receipt. A sale a full storno reversed holds nothing.
 *
 * ⚠ R3 feeds this: a partial storno at the till takes what it returns per rate with `takeBudget` on
 * its sale, and gives it back with `giveBackBudget` when its receipt does not print. A refund citing
 * that sale then counts what its stornos gave back, and the other way round, because both read and
 * write `register.refundClaims` on the one document they both reverse.
 *
 * ⚠ The claim is ONE atomic update on the cited document, with the check that it fits inside it
 * (`fitsBudget`), as a payment's hold is (`fitsDue`). The spec asked for R0's `_id` order, and that
 * order cannot hold money: a claim that writes and then reads only knows the claims written before its
 * read, and `_id` says nothing about when one was written (two pods mint them independently within a
 * second). So a claim with a later `_id` that read first goes ahead, a claim with an earlier one written
 * after it reads "I am first" and goes ahead too, and one receipt is refunded twice. A later claim that
 * does not fit gives way here too; later means what it should: it reached the document later.
 *
 * Cents throughout, per rate. Import-pure but for the two writes at the bottom.
 */
import { Invoice } from 'db/models'
import { grossByRate } from './receipt-lines.js'

/** VAT rate → cents. */
export type ByRate = Map<number, number>

type ObjectId = InstanceType<typeof Invoice.base.Types.ObjectId>
const oid = (v: unknown): ObjectId => new Invoice.base.Types.ObjectId(String(v))
const toCents = (v: unknown) => Math.round((Number(v) || 0) * 100)

export function totalOf(byRate: ByRate): number {
  let sum = 0
  for (const cents of byRate.values()) sum += cents
  return sum
}

/** What a document printed, per rate: its lines, adding up to its total exactly. */
export function printedByRate(cited: any): ByRate {
  return new Map((grossByRate(cited) ?? []).map(g => [g.rate, toCents(g.gross)]))
}

/** What stornos have taken of it, printed or still printing. */
export function takenByRate(cited: any): ByRate {
  const out: ByRate = new Map()
  for (const c of cited.register?.refundClaims ?? []) out.set(c.rate, (out.get(c.rate) || 0) + (Number(c.cents) || 0))
  return out
}

/** What it still holds, per rate. A sale a full storno reversed holds nothing. */
export function leftByRate(cited: any): ByRate {
  const out: ByRate = new Map()
  if (cited.register?.stornoState === 'full') return out
  const taken = takenByRate(cited)
  for (const [rate, cents] of printedByRate(cited)) {
    const left = cents - (taken.get(rate) || 0)
    if (left > 0) out.set(rate, left)
  }
  return out
}

/** What a storno's own lines give back, per rate. */
export function wantedBy(storno: { lines?: { taxRate?: number; lineTotal?: number }[] }): ByRate {
  const out: ByRate = new Map()
  for (const l of storno.lines ?? []) out.set(Number(l.taxRate) || 0, (out.get(Number(l.taxRate) || 0) || 0) + toCents(l.lineTotal))
  return out
}

/** Whether, between them, these hold `need` at every rate. */
export function holdEnough(need: ByRate, cited: any[]): boolean {
  const lefts = cited.map(leftByRate)
  return [...need].every(([rate, cents]) => lefts.reduce((s, l) => s + (l.get(rate) || 0), 0) >= cents)
}

/**
 * §2.5, which receipt a refund draws on next: the newest with enough left for all of it. A refund larger
 * than any one's remainder takes what the newest with anything left can give, and the next storno the
 * rest. Null when nothing holds any of it.
 */
export function drawOn(need: ByRate, cited: any[]): { cited: any; take: ByRate } | null {
  const newestFirst = [...cited].sort((a, b) => (String(a._id) < String(b._id) ? 1 : -1))
  const whole = newestFirst.find(c => {
    const left = leftByRate(c)
    return [...need].every(([rate, cents]) => (left.get(rate) || 0) >= cents)
  })
  if (whole) return { cited: whole, take: new Map(need) }
  for (const c of newestFirst) {
    const left = leftByRate(c)
    const take: ByRate = new Map()
    for (const [rate, cents] of need) {
      const part = Math.min(cents, left.get(rate) || 0)
      if (part > 0) take.set(rate, part)
    }
    if (take.size) return { cited: c, take }
  }
  return null
}

/** The filter that lets a claim through only while it fits, per rate, inside the update. */
function fitsBudget(printed: ByRate, want: ByRate): Record<string, unknown> {
  const claims = { $ifNull: ['$register.refundClaims', []] }
  return {
    $expr: {
      $and: [...want].map(([rate, cents]) => ({
        $lte: [
          {
            $add: [
              { $sum: { $map: { input: { $filter: { input: claims, cond: { $eq: ['$$this.rate', rate] } } }, in: '$$this.cents' } } },
              cents,
            ],
          },
          printed.get(rate) || 0,
        ],
      })),
    },
  }
}

/**
 * Take `want` from what `cited` holds, for `stornoId`, atomically. False when it does not fit, and it
 * then takes nothing: the storno gives way. Safe to repeat: a resume finds its claim standing.
 */
export async function takeBudget(cited: any, stornoId: unknown, want: ByRate): Promise<boolean> {
  const id = oid(stornoId)
  const taken = await Invoice.findOneAndUpdate(
    {
      _id: cited._id, orgId: cited.orgId, status: { $ne: 'voided' },
      // Of a full storno and a refund at once one gives way: `claimForStorno` asks for no claims here.
      'register.stornoState': { $ne: 'full' },
      'register.refundClaims.stornoId': { $ne: id },
      ...fitsBudget(printedByRate(cited), want),
    },
    { $push: { 'register.refundClaims': { $each: [...want].map(([rate, cents]) => ({ stornoId: id, rate, cents })) } } },
    { new: true },
  ).lean().exec()
  return !!taken || !!(await Invoice.exists({ _id: cited._id, orgId: cited.orgId, 'register.refundClaims.stornoId': id }).exec())
}

/** A storno that did not print gives back what it took. Safe to repeat. */
export async function giveBackBudget(citedId: unknown, orgId: unknown, stornoId: unknown): Promise<void> {
  await Invoice.updateOne(
    { _id: citedId, orgId, 'register.refundClaims.stornoId': oid(stornoId) },
    { $pull: { 'register.refundClaims': { stornoId: oid(stornoId) } } },
  ).exec()
}
