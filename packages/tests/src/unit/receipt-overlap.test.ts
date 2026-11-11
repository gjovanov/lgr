import { describe, it, expect } from 'bun:test'
import { preselectedReceipts } from '../../../invoicing-ui/src/composables/receipt-overlap'
import { deliveryNote, deliveryNotePartner, isRemovalReversalNote, movementMarker, noteSaysNoDelivery, reconcileNote, removalReversalNote } from 'config/movement-notes'

/** #168: what the two dialogs tick for the person, and what a receipt's notes say about it. */

describe('what is ticked for the person', () => {
  const own = { id: 'own' }
  const another = { id: 'another' }
  const stray = (id: string) => ({ id, noSupplier: true })

  it('the one receipt naming the supplier, however many that name nobody stand beside it', () => {
    expect(preselectedReceipts([own])).toEqual(['own'])
    expect(preselectedReceipts([own, stray('a'), stray('b'), stray('c')])).toEqual(['own'])
  })

  it('nothing when there are two to choose between, or only ones that name nobody', () => {
    expect(preselectedReceipts([own, another, stray('a')])).toEqual([])
    expect(preselectedReceipts([stray('a')])).toEqual([])
    expect(preselectedReceipts([stray('a'), stray('b')])).toEqual([])
    expect(preselectedReceipts([])).toEqual([])
  })
})

describe('what a receipt\'s notes say', () => {
  it('a correction, a reconcile delta, a day\'s aggregate, and a transfer or write-off note say no delivery', () => {
    expect(noteSaysNoDelivery(`Корекция — 2026-10-20 (${movementMarker('correction', '1')}) (+)`)).toBe(true)
    expect(noteSaysNoDelivery(deliveryNote('2026-10-20', movementMarker('goods_receipt', '1'), '2000 КОРЕКЦИЯ'))).toBe(true)
    expect(noteSaysNoDelivery(reconcileNote('stokrazp_1.pdf', 2, 'reconcile:1-v2'))).toBe(true)
    expect(noteSaysNoDelivery(deliveryNote('2026-10-20', movementMarker('store_operations', '2026-10-20')))).toBe(true)
    expect(noteSaysNoDelivery(`Прехвърляне — 2026-10-20 (${movementMarker('transfer_note', '1')}) (−)`)).toBe(true)
    expect(noteSaysNoDelivery(`Отписване — 2026-10-20 (${movementMarker('issue_note', '1')}) (−)`)).toBe(true)
  })

  it('a разписка says nothing of the kind, whoever it names, and neither does free text', () => {
    expect(noteSaysNoDelivery(deliveryNote('2026-10-20', movementMarker('goods_receipt', '1')))).toBe(false)
    expect(noteSaysNoDelivery(deliveryNote('2026-10-20', movementMarker('goods_receipt', '1'), 'склад'))).toBe(false)
    expect(noteSaysNoDelivery('Incorr: wrong box, see supplier')).toBe(false)
    expect(noteSaysNoDelivery('')).toBe(false)
    expect(noteSaysNoDelivery(undefined)).toBe(false)
  })

  it('a delivery\x27s note gives back the partner its writer was given, and only that', () => {
    const marker = movementMarker('goods_receipt', '3000619317')
    expect(deliveryNotePartner(deliveryNote('2026-10-20', marker, 'ПАРТНЬОРИ:ТЕСТ СЕНТЕР ЕООД'))).toBe('ПАРТНЬОРИ:ТЕСТ СЕНТЕР ЕООД')
    expect(deliveryNotePartner(deliveryNote('2026-10-20', marker, 'Test Centre Ltd'))).toBe('Test Centre Ltd')
    // A name may hold brackets and a dash of its own: the marker is the LAST bracket.
    expect(deliveryNotePartner(deliveryNote('2026-10-20', marker, 'ТЕСТ (БЪЛГАРИЯ) — КЛОН ЕООД'))).toBe('ТЕСТ (БЪЛГАРИЯ) — КЛОН ЕООД')
    expect(deliveryNotePartner(`  ${deliveryNote('2026-10-20', marker, 'склад')}  `)).toBe('склад')
  })

  it('a note that names nobody, or is no delivery\x27s note, gives no partner', () => {
    expect(deliveryNotePartner(deliveryNote('2026-10-20', movementMarker('goods_receipt', '1')))).toBeUndefined()
    expect(deliveryNotePartner(deliveryNote('2026-10-20', movementMarker('store_operations', '2026-10-20')))).toBeUndefined()
    expect(deliveryNotePartner(`Корекция от стокова разписка — 2026-10-20 (${movementMarker('correction', '1')})`)).toBeUndefined()
    expect(deliveryNotePartner(reconcileNote('stokrazp_1.pdf', 2, 'reconcile:1-v2'))).toBeUndefined()
    expect(deliveryNotePartner(removalReversalNote('SM-2026-00001', '0000000777'))).toBeUndefined()
    expect(deliveryNotePartner('Доставки — 2026-10-20 — без маркер')).toBeUndefined()
    for (const v of ['', undefined, null, 42]) expect(deliveryNotePartner(v)).toBeUndefined()
  })
  it('the mirror of a removed document reads as what the writer wrote', () => {
    expect(isRemovalReversalNote(removalReversalNote('SM-2026-00001', '0000000777'))).toBe(true)
    expect(isRemovalReversalNote(deliveryNote('2026-10-20', 'stokrazp:1'))).toBe(false)
  })
})
