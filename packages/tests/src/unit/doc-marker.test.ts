/**
 * The idempotency marker of a booked PlusMinus document, read numerically: the PDF-era flow wrote
 * `sklrazp:0000012705`, the direct-API flow writes `sklrazp:12705`, and both are the same document.
 * Found on regal-pz 2026-11-01 — a substring check booked ~50 transfers a second time in the dry-run.
 */
import { describe, it, expect } from 'bun:test'
import { docMarkerNumbers, hasDocMarker, loadBookedDocNumbers } from '../../../../scripts/lib/doc-marker'

describe('docMarkerNumbers', () => {
  it('reads a zero-padded and an unpadded marker as the same number', () => {
    expect(docMarkerNumbers('sklrazp', 'Прехвърляне — 2026-08-27 (sklrazp:0000012705)')).toEqual([12705])
    expect(docMarkerNumbers('sklrazp', 'Предаване — 2026-10-29 (sklrazp:12809)')).toEqual([12809])
  })

  it('reads the Files-app reference spelling too (underscore, .pdf)', () => {
    expect(docMarkerNumbers('sklrazp', '', 'sklrazp_0000012713.pdf')).toEqual([12713])
    expect(docMarkerNumbers('stokrazp', null, 'stokrazp_3000009311.pdf')).toEqual([3000009311])
  })

  it('ignores a suffix after the digits (rcl / -fix reclass and repair variants)', () => {
    expect(docMarkerNumbers('stokrazp', '(stokrazp:3000009194rcl)')).toEqual([3000009194])
    expect(docMarkerNumbers('stokrazp', 'stokrazp_3000009311-fix')).toEqual([3000009311])
  })

  it('does not mix families', () => {
    expect(docMarkerNumbers('sklisk', 'sklrazp:0000012705 and stokrazp:3000009475')).toEqual([])
  })

  it('reads several markers in one note', () => {
    expect(docMarkerNumbers('stokrazp', 'a (stokrazp:3000009127) b (stokrazp:3000009134)')).toEqual([3000009127, 3000009134])
  })
})

describe('hasDocMarker', () => {
  it('matches the same document across paddings, in either direction', () => {
    expect(hasDocMarker('sklrazp', '12705', 'x (sklrazp:0000012705)')).toBe(true)
    expect(hasDocMarker('sklrazp', '0000012705', 'x (sklrazp:12705)')).toBe(true)
    expect(hasDocMarker('sklisk', 130, 'Изписване (sklisk:0000000130)')).toBe(true)
  })

  it('never matches a longer number that merely contains the digits', () => {
    expect(hasDocMarker('sklrazp', '12705', 'x (sklrazp:127055)')).toBe(false)
    expect(hasDocMarker('sklrazp', '1270', 'x (sklrazp:12705)')).toBe(false)
  })

  it('is false for a non-numeric document number', () => {
    expect(hasDocMarker('sklrazp', 'abc', 'x (sklrazp:12705)')).toBe(false)
  })
})

describe('loadBookedDocNumbers', () => {
  const movements = [
    { movementNumber: 'SM-1', notes: 'Прехвърляне — 2026-08-27 (sklrazp:0000012705)' },
    { movementNumber: 'SM-2', notes: 'Предаване — 2026-10-29 (sklrazp:12809)' },
    { movementNumber: 'SM-3', notes: '', reference: 'sklrazp_0000012713.pdf' },
    { movementNumber: 'SM-4', notes: 'no marker here' },
    { movementNumber: 'SM-5', notes: 'dup (sklrazp:12705)' },
  ]

  it('collects every number across pages, keeping the first movement per number', async () => {
    const pages: string[] = []
    const booked = await loadBookedDocNumbers(async (page, size) => {
      pages.push(`${page}/${size}`)
      return { movements: movements.slice(page * size, page * size + size), total: movements.length }
    }, 'sklrazp', 2)
    expect([...booked.entries()].sort((a, b) => a[0] - b[0])).toEqual([[12705, 'SM-1'], [12713, 'SM-3'], [12809, 'SM-2']])
    expect(pages).toEqual(['0/2', '1/2', '2/2'])
  })

  it('stops after a short page without needing a total', async () => {
    const booked = await loadBookedDocNumbers(async () => ({ movements: movements.slice(0, 2) }), 'sklrazp', 500)
    expect([...booked.keys()].sort((a, b) => a - b)).toEqual([12705, 12809])
  })
})
