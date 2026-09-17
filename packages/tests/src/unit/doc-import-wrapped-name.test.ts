/**
 * Стокова разписка 3000016401 of 2026-09-16, verbatim — an 11-line table in which FIVE names and
 * one price wrap across physical lines. It is here because it is the densest real example of the
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
  "Склад / Магазин:                   СКЛАД - 1                       Доставчик:                       СЕВАН - 7 СД",
  "",
  "No                    Име                    Мяр         Кол       Цена     Прод.         Цена     Цена 1       Цена 2   Забележка",
  "                                              .                             цена           на",
  "                                                                                          едро",
  "1      ВИНТ - САМОПР. - 5.5Х25 - ПОКР.-      БР         200.000    0.0900       0.100      0.12     0.0740      0.0618",
  "       САМОНАРЕЗ.",
  "2      ТРЕГЕРЕН ОКАЧВАЧ - М8 - DIN           БР         100.000    0.9300       1.000      1.20     0.7410      0.6180",
  "       1684",
  "3      ТРЕГЕРЕН ОКАЧВАЧ - М10 - DIN          БР           50.000   1.2800       1.400      1.68     1.0200      0.8530",
  "       1684",
  "4      ВИНТ 6Х80 - ТХ - EVOLUTION            БР        3600.000    0.0670       0.121      0.14     0.0607      0.0041",
  "5      АНКЕР - СЕГМЕНТЕН - 14Х180            БР         100.000    1.0900       1.200      1.44     0.8700      0.7260",
  "6      ВИНТ 3Х30                             БР       12000.000    0.0061       0.018      0.02     0.0040      0.0034",
  "7      ГАЙКА М36 - DIN 934 - K 8 - ZN        БР         150.000    1.5000       1.670      2.00     1.2000      0.9844",
  "8      БОЛТ М27Х130 - DIN 931 - K 10.9       БР           35.000   5.1800       5.700      6.84     4.1500      3.4560",
  "       - ZN",
  "9      БОЛТ М24Х110 - DIN 931 - K 10.9       БР           16.000   3.6400       4.000      4.80     2.9000      2.4180",
  "       - ZN",
  "10     ШПИЛКА - М16 - DIN 975 - K 10.9       БР           10.000   11.000   12.100        14.52     5.3940      4.4950",
  "       - ZN                                                             0",
  "11     ВИНТ 3.5Х16                           БР       24000.000    0.0045       0.010      0.01     0.0034      0.0028",
  "",
  "Словом: хиляда двеста и осемдесет евро и 94 цента                                          Данъчна основа                   1280.94",
  "                                                                                           Данък размер (0%)                   0.00",
  "                                                                                           Крайна сума                     1280.94",
].join('\n')

/** Interior spacing is what the matcher normalises away; compare names the same way it does. */
const despace = (s: string) => s.replace(/\s+/g, '')

describe('стокова разписка 3000016401 — five names and a price wrapped across lines', () => {
  const t = parseTable(RAZPISKA)

  it('reads all eleven rows and reconciles against the printed total', () => {
    expect(t.ok).toBe(true)
    expect(t.lines).toHaveLength(11)
    expect(t.footer).toBeCloseTo(1280.94, 2)
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
    // „11.000" / „0" on the ШПИЛКА row is 11.0000 — read as 11.000 it would still reconcile,
    // which is why the wrap has to be rejoined rather than trusted for reconciling alone
    expect(t.lines[9].prices['Цена']).toBeCloseTo(11, 4)
    expect(t.lines[9].total).toBeCloseTo(110, 2)
  })
})
