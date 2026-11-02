/**
 * Стокова разписка 3000619401 — an 11-line table in which FIVE names and
 * one price wrap across physical lines. It is here because it is the densest example of the
 * wrapping the parser has to survive, and because it settles a question that looked simple:
 *
 *   „ВИНТ - САМОПР. - 5.5Х25 - ПОКР.-" / „САМОНАРЕЗ."   →  „… ПОКР.-САМОНАРЕЗ."   (no space)
 *   „ТРЕГЕРЕН ОКАЧВАЧ - М8 - DIN" / „1684"              →  „… - DIN 1684"         (space)
 *   „БОЛТ М27Х130 - DIN 931 - K 10.9" / „- ZN"          →  „… - K 10.9 - ZN"      (space)
 *
 * PlusMinus breaks a line at a space AND after a hyphen, and both leave a fragment ending in „-",
 * so the text alone cannot say which. Nor can convention: the live catalog spells 1707 names
 * „X-Y" and 217 „X- Y" — „МИСТРИЯ - 200ММ - ПЛ.ДР.- ОБЛА" really does carry that space.
 *
 * So the parser does NOT try to guess; it joins on a space and the MATCHER is what resolves the
 * difference, comparing with all whitespace stripped (matching.ts rung 3b) against the catalog —
 * ground truth instead of a coin flip. These assertions are therefore about the numbers and the
 * line count, which are unambiguous, and deliberately not about interior spacing.
 */
import { describe, it, expect } from 'bun:test'
import { parseTable } from 'services/biz/doc-import/parse-table'

const RAZPISKA = [
  "Склад / Магазин:                   СКЛАД - 1                       Доставчик:                       ТЕСТ - 7 СД",
  "",
  "No                    Име                    Мяр         Кол       Цена     Прод.         Цена     Цена 1       Цена 2   Забележка",
  "                                              .                             цена           на",
  "                                                                                          едро",
  "1      ВИНТ - САМОПР. - 5.5Х25 - ПОКР.-      БР         200.000    0.1000       0.110      0.13     0.0800      0.0700",
  "       САМОНАРЕЗ.",
  "2      ТРЕГЕРЕН ОКАЧВАЧ - М8 - DIN           БР         100.000    1.0000       1.100      1.30     0.8000      0.7000",
  "       1684",
  "3      ТРЕГЕРЕН ОКАЧВАЧ - М10 - DIN          БР           50.000   1.2000       1.300      1.60     0.9600      0.8400",
  "       1684",
  "4      ВИНТ 6Х80 - ТХ - EVOLUTION            БР        3600.000    0.0500       0.060      0.07     0.0400      0.0350",
  "5      АНКЕР - СЕГМЕНТЕН - 14Х180            БР         100.000    1.1000       1.200      1.40     0.8800      0.7700",
  "6      ВИНТ 3Х30                             БР       12000.000    0.0050       0.010      0.01     0.0040      0.0035",
  "7      ГАЙКА М36 - DIN 934 - K 8 - ZN        БР         150.000    1.4000       1.500      1.80     1.1200      0.9800",
  "8      БОЛТ М27Х130 - DIN 931 - K 10.9       БР           35.000   5.0000       5.500      6.50     4.0000      3.5000",
  "       - ZN",
  "9      БОЛТ М24Х110 - DIN 931 - K 10.9       БР           16.000   3.5000       3.900      4.50     2.8000      2.4500",
  "       - ZN",
  "10     ШПИЛКА - М16 - DIN 975 - K 10.9       БР           10.000   10.000   11.000        13.00     8.0000      7.0000",
  "       - ZN                                                             0",
  "11     ВИНТ 3.5Х16                           БР       24000.000    0.0040       0.005      0.01     0.0030      0.0028",
  "",
  "Словом: хиляда сто шестдесет и седем евро                                                  Данъчна основа                   1167.00",
  "                                                                                           Данък размер (0%)                   0.00",
  "                                                                                           Крайна сума                     1167.00",
].join('\n')

/** Interior spacing is what the matcher normalises away; compare names the same way it does. */
const despace = (s: string) => s.replace(/\s+/g, '')

describe('стокова разписка 3000619401 — five names and a price wrapped across lines', () => {
  const t = parseTable(RAZPISKA)

  it('reads all eleven rows and reconciles against the printed total', () => {
    expect(t.ok).toBe(true)
    expect(t.lines).toHaveLength(11)
    expect(t.footer).toBeCloseTo(1167, 2)
  })

  it('does not lose or merge a row whose name wrapped', () => {
    // the failure this guards against is a wrapped row swallowing the next one
    expect(t.lines.map(l => l.quantity)).toEqual([200, 100, 50, 3600, 100, 12000, 150, 35, 16, 10, 24000])
  })

  it('recovers each wrapped name, up to the interior spacing the matcher strips', () => {
    const got = t.lines.map(l => despace(l.description))
    expect(got[0]).toBe(despace('ВИНТ - САМОПР. - 5.5Х25 - ПОКР.-САМОНАРЕЗ.'))
    expect(got[1]).toBe(despace('ТРЕГЕРЕН ОКАЧВАЧ - М8 - DIN 1684'))
    expect(got[2]).toBe(despace('ТРЕГЕРЕН ОКАЧВАЧ - М10 - DIN 1684'))
    expect(got[7]).toBe(despace('БОЛТ М27Х130 - DIN 931 - K 10.9 - ZN'))
    expect(got[8]).toBe(despace('БОЛТ М24Х110 - DIN 931 - K 10.9 - ZN'))
    expect(got[9]).toBe(despace('ШПИЛКА - М16 - DIN 975 - K 10.9 - ZN'))
  })

  it('leaves the names that did not wrap exactly as printed', () => {
    expect(t.lines[3].description).toBe('ВИНТ 6Х80 - ТХ - EVOLUTION')
    expect(t.lines[10].description).toBe('ВИНТ 3.5Х16')
  })

  it('reads a price that wrapped with its name', () => {
    // „10.000" / „0" on the ШПИЛКА row is 10.0000 — read as 10.000 it would still reconcile,
    // which is why the wrap has to be rejoined rather than trusted for reconciling alone
    expect(t.lines[9].prices['Цена']).toBeCloseTo(10, 4)
    expect(t.lines[9].total).toBeCloseTo(100, 2)
  })
})
