/**
 * The pure rules behind the PlusMinus↔LGR document audit. The guard (`classifyLine`) is what stops a
 * late-found document from being booked twice; `lineItemName` is the alias-vs-item identity rule.
 */
import { describe, it, expect } from 'bun:test'
import {
  fold, stripLabel, lineItemName, docLineEffects, classifyLine, isPreBaseline, isoFromPm,
} from '../../../../scripts/lib/audit-coverage'

describe('fold', () => {
  it('ignores case, spacing and Latin look-alikes of Cyrillic letters', () => {
    expect(fold('ВИНТ - САМОПР. - 6.3Х100 - DIN 7504 K')).toBe(fold('винт - самопр. - 6.3х100 - din 7504 к'))
    expect(fold('1511 НАКРАЙНИК РZ 4Х32')).toBe(fold('1511 НАКРАЙНИК PZ 4Х32'))
    expect(fold('ГАЙКА   М6')).toBe(fold('гайка м6'))
  })

  it('keeps genuinely different articles apart', () => {
    expect(fold('ШАЙБА - ЗАКОНТРЯЩА - М16 - НОРД ЛОК')).not.toBe(fold('ШАЙБА - ЗАКОНТРЯЩА - М16 - НОРДЛОК'))
    expect(fold('ГАЙКА М6')).not.toBe(fold('ГАЙКА М8'))
  })
})

describe('lineItemName', () => {
  it('takes identity from the stock item, not the display alias', () => {
    expect(lineItemName({ name: 'ГАЙКА М10 - DIN 985 - А2 - Gleitmo', item: 'СТОКИ:ГАЙКА М10 - DIN 985 - А2' })).toBe('ГАЙКА М10 - DIN 985 - А2')
    expect(lineItemName({ name: 'ШАЙБА - ПОДЛ. - Ф6Х24 - Ш.П', item: 'СТОКИ:ШАЙБА - ПОДЛ. - Ф6Х24 - Ш.П.' })).toBe('ШАЙБА - ПОДЛ. - Ф6Х24 - Ш.П.')
  })

  it('falls back to the name when a line has no item', () => {
    expect(lineItemName({ name: ' ВИНТ 5Х50 ' })).toBe('ВИНТ 5Х50')
    expect(lineItemName({ name: 'X', item: '' })).toBe('X')
  })

  it('strips only the known groups, not a colon inside a name', () => {
    expect(stripLabel('УСЛУГИ:Комисионна')).toBe('Комисионна')
    expect(stripLabel('КИТ:Винт DIN 914')).toBe('КИТ:Винт DIN 914')
  })
})

describe('docLineEffects', () => {
  const doc = { lines: [
    { name: 'A', item: 'СТОКИ:A', quantity: '10' },
    { name: 'A', item: 'СТОКИ:A', quantity: '5' },
    { name: 'B', quantity: '-3' },
    { name: 'C', quantity: '0' },
    { name: '', quantity: '4' },
  ] }

  it('signs a receipt as stock IN and merges lines of the same article', () => {
    const e = docLineEffects('stokrazp', doc)
    expect(e.map(x => [x.name, x.eff])).toEqual([['A', 15], ['B', -3]])
  })

  it('signs a transfer-out and a write-off as stock OUT', () => {
    expect(docLineEffects('sklrazp', doc).map(x => x.eff)).toEqual([-15, 3])
    expect(docLineEffects('sklisk', doc).map(x => x.eff)).toEqual([-15, 3])
  })

  it('reads a decimal-comma quantity', () => {
    expect(docLineEffects('stokrazp', { lines: [{ name: 'X', quantity: '1,5' }] })[0].eff).toBe(1.5)
  })
})

describe('classifyLine (gap = snapshot − LGR)', () => {
  it('EXACT when the document alone closes the gap', () => {
    expect(classifyLine(40880, 40880)).toBe('EXACT')
    expect(classifyLine(-1000, -1000)).toBe('EXACT')
  })

  it('EXACT when several documents together close it', () => {
    expect(classifyLine(30, 10, 30)).toBe('EXACT')
  })

  it('ALREADY when LGR agrees with the snapshot — booking would create drift', () => {
    expect(classifyLine(0, 2)).toBe('ALREADY')
    expect(classifyLine(0.0004, 2)).toBe('ALREADY')
  })

  it('PARTIAL when same direction and smaller than the gap', () => {
    expect(classifyLine(100, 40)).toBe('PARTIAL')
    expect(classifyLine(-100, -40)).toBe('PARTIAL')
  })

  it('CONTRA when opposite direction or larger than the whole gap', () => {
    // real regal-pz shape: LGR is 72 BELOW the snapshot, yet three write-offs would remove 36 more
    expect(classifyLine(72, -36, -36)).toBe('CONTRA')
    expect(classifyLine(100, -5)).toBe('CONTRA')
    expect(classifyLine(10, 25, 25)).toBe('CONTRA')
  })

  it('NOPRODUCT when LGR has no such article', () => {
    expect(classifyLine(null, 20)).toBe('NOPRODUCT')
  })
})

describe('baseline and dates', () => {
  it('treats the baseline day itself as inside the baseline', () => {
    expect(isPreBaseline('2026-07-30', '2026-07-30')).toBe(true)
    expect(isPreBaseline('2026-07-31', '2026-07-30')).toBe(false)
  })

  it('with no baseline nothing is pre-baseline', () => {
    expect(isPreBaseline('2020-01-01', undefined)).toBe(false)
  })

  it('converts PlusMinus dates', () => {
    expect(isoFromPm('20261101')).toBe('2026-11-01')
    expect(isoFromPm('garbage')).toBe('garbage')
  })
})
