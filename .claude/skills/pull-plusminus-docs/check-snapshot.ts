// Is this storeAvailability export complete? A full export lists every catalog product,
// thousands of them with an empty Количество; one exported without the
// "Извеждане на стоките с нулеви количества" tick lists only products in stock, and a
// compare or re-baseline against it never learns that a product sold out.
//
//   bun .claude/skills/pull-plusminus-docs/check-snapshot.ts <storeAvailability_*.xlsx>
import ExcelJS from 'exceljs'

const file = process.argv[2]
if (!file) { console.error('check-snapshot.ts <storeAvailability_*.xlsx>'); process.exit(2) }
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(file)
const cell = (v: any) => (v && typeof v === 'object' && 'result' in v ? v.result : v)

let head: string[] | null = null
let rows = 0, zero = 0, sum = 0, total: number | null = null
wb.worksheets[0].eachRow(r => {
  const v = (r.values as any[]).slice(1).map(cell)
  // The header row moves between layouts (see lgr-plusminus-export-drift): find it by name.
  if (!head) { if (String(v[0] ?? '').trim() === 'Име') head = v.map(x => String(x ?? '').replace(/\s/g, '')); return }
  const name = String(v[0] ?? '').trim()
  const q = Number(v[head.indexOf('Количество')]) || 0
  if (!name) return
  if (name === 'Всичко') { total = q; return }
  rows++; sum += q; if (q === 0) zero++
})
if (!head) { console.error(`${file}: no "Име" header row, not a storeAvailability export`); process.exit(1) }

const sumOk = total !== null && Math.abs(sum - total) < 0.01
console.log(JSON.stringify({ rows, zeroQtyRows: zero, sumQty: +sum.toFixed(4), vsichko: total, sumMatchesVsichko: sumOk }))
if (!sumOk) { console.error('INCOMPLETE: the rows do not add up to the file\'s own Всичко'); process.exit(1) }
if (zero === 0) { console.error('PARTIAL: no zero-quantity products, re-export with "Извеждане на стоките с нулеви количества" ticked'); process.exit(1) }
console.log('OK: full snapshot')
