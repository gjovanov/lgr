/**
 * `kindFromFilename` — the filename→kind hint the Stock Movements → Import wizard now sends,
 * closing the gap the Files app's own upload-time `PREFIX_TYPE` already covered. See
 * `useDocImport.ts`'s header comment for the 2026-10-29 stokrazp title-fragmentation story this
 * hint rescues.
 */
import { describe, it, expect } from 'bun:test'
import { kindFromFilename } from 'ui-shared/composables/useDocImport'

describe('kindFromFilename', () => {
  it('maps each known PlusMinus export prefix to its doc kind', () => {
    expect(kindFromFilename('invoicem_3000101649.pdf')).toBe('invoice')
    expect(kindFromFilename('stokrazp_3000016596.pdf')).toBe('goods_receipt')
    expect(kindFromFilename('sklrazp_778.pdf')).toBe('transfer_note')
    expect(kindFromFilename('sklisk_130.pdf')).toBe('issue_note')
  })

  it('returns undefined for an unrecognised prefix or filename, rather than guessing', () => {
    expect(kindFromFilename('storeAvailability_20261027.xlsx')).toBeUndefined()
    expect(kindFromFilename('scan001.pdf')).toBeUndefined()
    expect(kindFromFilename(undefined)).toBeUndefined()
    expect(kindFromFilename('')).toBeUndefined()
  })
})
