import { describe, it, expect } from 'bun:test'
import { verdictOfFailedPrint, type FailedPrint, type PrintVerdict } from 'services/biz/cash-register/print-verdict'

/** FR-23, ruling 1: what a fiscal print that threw left behind, in the document's turn on the device. */
describe('what a print that threw left behind', () => {
  const table: Array<[string, FailedPrint, PrintVerdict]> = [
    // The counter says.
    ['moved by one: the close went through, whatever the error said', { stage: 'closing', before: 7, now: 8 }, 'printed'],
    ['moved by one at any stage: abandoning it finished it', { stage: 'paying', before: 7, now: 8, open: false }, 'printed'],
    ['moved by two in a turn: not this one alone', { stage: 'closing', before: 7, now: 9 }, 'unknown'],
    ['moved backwards: a device replaced under it', { stage: 'lines', before: 7, now: 3, open: false }, 'unknown'],
    ['moved by two, and a line was all it got: still not proved', { stage: 'lines', before: 7, now: 9 }, 'unknown'],

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
    ['a driver that does the whole receipt in one call says nothing about how far', { before: 7 }, 'unknown'],
    ['nothing at all', {}, 'unknown'],

    // A driver with no cancel closes the receipt: a real receipt, for how much it cannot say.
    ['the fallback close went through, no counter', { stage: 'lines', closed: true }, 'unknown'],
    ['the fallback close went through, the counter by one', { stage: 'lines', before: 7, now: 8, closed: true }, 'printed'],
    ['the fallback close went through, the counter unmoved', { stage: 'lines', before: 7, now: 7, open: false, closed: true }, 'unknown'],
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
