import { describe, it, expect } from 'bun:test'
import { provedNotPrinted, verdictOfFailedPrint, type FailedPrint, type PrintVerdict } from 'services/biz/cash-register/print-verdict'

/** FR-23, ruling 1: what a fiscal print that threw left behind, in the document's turn on the device. */
describe('what a print that threw left behind', () => {
  const table: Array<[string, FailedPrint, PrintVerdict]> = [
    // The counter says.
    ['moved by one: the close went through, whatever the error said', { stage: 'closing', before: 7, now: 8 }, 'printed'],
    ['moved by one past the money: abandoning it finished it', { stage: 'paying', before: 7, now: 8, open: false }, 'printed'],
    ['moved by two in a turn: not this one alone', { stage: 'closing', before: 7, now: 9 }, 'unknown'],
    ['moved backwards past the money: a device replaced under it', { stage: 'paying', before: 7, now: 3, open: false }, 'unknown'],

    // Before the money nothing can close this document, whatever the counter says (finding 1).
    ['moved by one at a line: a leftover, or a voided receipt numbered', { stage: 'lines', before: 7, now: 8, open: false }, 'failed'],
    ['moved by one opening: the same', { stage: 'opening', before: 7, now: 8 }, 'failed'],
    ['moved by one at a line, a receipt still open', { stage: 'lines', before: 7, now: 8, open: true }, 'failed'],
    ['moved by two at a line', { stage: 'lines', before: 7, now: 9 }, 'failed'],
    ['moved backwards at a line', { stage: 'lines', before: 7, now: 3, open: false }, 'failed'],
    ['refused by the driver: the device never saw it', { stage: 'refused', before: 7, now: 7 }, 'failed'],

    // Unmoved, and the device confirms nothing is open.
    ['unmoved and idle at a line', { stage: 'lines', before: 7, now: 7, open: false }, 'failed'],
    ['unmoved and idle at the close: voided, or refused before it', { stage: 'closing', before: 7, now: 7, open: false }, 'failed'],
    ['unmoved and idle after a payment the device refused', { stage: 'paying', before: 7, now: 7, open: false }, 'failed'],

    // Unmoved, with a receipt still open, or nothing to say about one: how far it got is what is left.
    ['unmoved, still open, past the money: the device has it', { stage: 'paying', before: 7, now: 7, open: true }, 'unknown'],
    ['unmoved, still open, at the close', { stage: 'closing', before: 7, now: 7, open: true }, 'unknown'],
    ['unmoved, cannot say if open, past the money', { stage: 'paying', before: 7, now: 7 }, 'unknown'],
    ['unmoved, cannot say if open, before the money', { stage: 'lines', before: 7, now: 7 }, 'failed'],
    ['unmoved, still open, before the money', { stage: 'lines', before: 7, now: 7, open: true }, 'failed'],
    ['never got past opening', { stage: 'opening', before: 7, now: 7 }, 'failed'],

    // No reading to compare.
    ['no counter before, at a line', { stage: 'lines', before: null, now: 8 }, 'failed'],
    ['no counter before, past the money', { stage: 'paying', before: null, now: 8 }, 'unknown'],
    ['no counter now, at the close', { stage: 'closing', before: 7 }, 'unknown'],
    ['no counter now, opening', { stage: 'opening', before: 7 }, 'failed'],
    ['a driver that does not say how far it got', { before: 7 }, 'unknown'],
    ['nothing at all', {}, 'unknown'],

    // A driver's fallback closes the receipt: a real receipt, for how much it cannot say.
    ['finished, no counter', { stage: 'lines', abandoned: 'finished' }, 'unknown'],
    ['finished past the money, the counter by one', { stage: 'paying', before: 7, now: 8, abandoned: 'finished' }, 'printed'],
    ['finished at a line, the counter by one: real, and only part of it', { stage: 'lines', before: 7, now: 8, abandoned: 'finished' }, 'unknown'],
    ['finished opening', { stage: 'opening', before: 7, now: 8, abandoned: 'finished' }, 'unknown'],
    ['finished, the counter unmoved', { stage: 'lines', before: 7, now: 7, open: false, abandoned: 'finished' }, 'unknown'],
    ['finished past the money, the counter unmoved: its close lost its answer', { stage: 'paying', before: 7, now: 7, abandoned: 'finished' }, 'unknown'],

    // The driver saw it open and voided it: nothing of it is on the device, whatever 71h does (finding 2).
    ['voided at a line, 71h moved', { stage: 'lines', before: 7, now: 8, abandoned: 'voided' }, 'failed'],
    ['voided past the money, 71h moved: a device that numbers a voided receipt', { stage: 'paying', before: 7, now: 8, open: false, abandoned: 'voided' }, 'failed'],
    ['voided at the close, 71h moved', { stage: 'closing', before: 7, now: 8, open: false, abandoned: 'voided' }, 'failed'],
    ['voided, no counter at all', { stage: 'paying', abandoned: 'voided' }, 'failed'],

    // A driver that says nothing: as ever. Not open before its cancel is one of these (finding 2).
    ['no word past the money, the counter by one: a close whose answer was lost', { stage: 'paying', before: 7, now: 8, open: false, abandoned: undefined }, 'printed'],
    ['no word at the close, the counter by one', { stage: 'closing', before: 7, now: 8, open: false, abandoned: undefined }, 'printed'],
    ['no word past the money, unmoved and idle', { stage: 'paying', before: 7, now: 7, open: false, abandoned: undefined }, 'failed'],
  ]

  for (const [name, print, verdict] of table) {
    it(`${name}: ${verdict}`, () => {
      expect(verdictOfFailedPrint(print)).toBe(verdict)
    })
  }

  it('a counter of zero is a reading, not a missing one', () => {
    expect(verdictOfFailedPrint({ stage: 'closing', before: 0, now: 1 })).toBe('printed')
    expect(verdictOfFailedPrint({ stage: 'paying', before: 0, now: 0, open: false })).toBe('failed')
  })
})

/** Finding 6: a print read in a later turn, for any document. The device is shared, so a counter proves nothing but silence. */
describe('what a print that stopped in an earlier turn proves', () => {
  const table: Array<[string, { before?: number | null; now?: number; open?: boolean }, boolean]> = [
    ['unmoved and idle: nothing closed, and nothing will', { before: 7, now: 7, open: false }, true],
    ['a counter of zero, unmoved and idle', { before: 0, now: 0, open: false }, true],
    ['moved by one: its print, or anybody else\'s', { before: 7, now: 8, open: false }, false],
    ['moved by more', { before: 7, now: 9, open: false }, false],
    ['moved backwards: a device replaced', { before: 7, now: 3, open: false }, false],
    ['unmoved with a receipt open: it may be paid', { before: 7, now: 7, open: true }, false],
    ['unmoved, and it cannot say what is open', { before: 7, now: 7 }, false],
    ['no reading now', { before: 7, open: false }, false],
    ['no reading before', { now: 7, open: false }, false],
    ['null before: a device that could not say then', { before: null, now: 7, open: false }, false],
    ['nothing at all', {}, false],
  ]
  for (const [name, reading, proved] of table) {
    it(`${name}: ${proved ? 'it never printed' : 'nothing is proved'}`, () => {
      expect(provedNotPrinted(reading)).toBe(proved)
    })
  }
})
