/**
 * Render both companion documents to PDF with a fake invoice — no server, no Mongo.
 * Proves the new legal text, the per-kind reference heading and the additional-info block.
 *
 *   bun run <this file> [outDir]
 */
// Relative, not the `reporting/*` workspace alias: root scripts resolve from the repo root,
// which is not a workspace package (see preview-daily-digest.ts for the same reason).
import { generateCompanionDocPDF, type CompanionDocData } from '../packages/reporting/src/pdf/companion-doc.pdf.js'
import { generateCompanionDocXLSX } from '../packages/reporting/src/excel/companion-doc.excel.js'

const outDir = process.argv[2] || '.'
const locale = process.env.LOCALE || 'bg'

function fixture(kind: CompanionDocData['kind']): CompanionDocData {
  return {
    kind,
    number: kind === 'certificate' ? 'CERT-2026-00007' : 'PPP-2026-00011',
    date: new Date('2026-09-03'),
    recipient: { name: 'СОЛИТЕХ АД', city: 'СОФИЯ', address: 'БУЛ.ГОЦЕ ДЕЛЧЕВ 55', taxId: '200610482' },
    supplier: { name: 'РЕГАЛ ООД', city: 'ПАЗАРДЖИК', address: 'ПЛОВДИВСКА 110', taxId: '112500982' },
    lines: [
      { name: 'БОЛТ М10Х30 - DIN 933 - K 8.8 - ZN', unit: 'БР', quantity: 15 },
      { name: 'ВИНТ 6Х160 - ТХ - EVOLUTION', unit: 'БР', quantity: 300 },
      { name: 'ГАЙКА М10 - DIN 934 - 8 - ZN', unit: 'БР', quantity: 2 },
    ],
    sourceDocs: [{ label: 'Фактура', number: 'INV-2026-00042', date: new Date('2026-09-03') }],
    preparedBy: 'Николета Тачева, 1111',
    // This is the new field — what a user types into "Бележка към придружаващите документи".
    additionalInfo: 'Партида 4417, сертификат по EN 10204 3.1',
    locale,
  }
}

for (const kind of ['certificate', 'ppprotocol'] as const) {
  const data = fixture(kind)
  const pdf = await generateCompanionDocPDF(data)
  if (pdf) await Bun.write(`${outDir}/${kind}.pdf`, pdf)
  await Bun.write(`${outDir}/${kind}.xlsx`, await generateCompanionDocXLSX(data))
  console.log(`${kind}: ${pdf ? 'pdf + xlsx' : 'xlsx only (PDF renderer unavailable)'}`)
}
