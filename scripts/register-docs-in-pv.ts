/**
 * One-time _docs → PV registration (runs INSIDE the lgr pod, from /app/packages/db).
 *
 * The files must already be on the PV under `/app/uploads/<orgId>/docs/<date>/<name>` (transferred
 * by scripts/push-docs-to-pv.sh). This walks that tree and creates a DocFile row per document with
 * the FOLDER name as its date — NO OCR, NO booking. Idempotent: a doc whose {docType,docNumber} is
 * already tracked is left untouched (so the docs we've been testing with are not disturbed).
 *
 * DRY-RUN by default; set EXECUTE=1 to write. Pipe via stdin:
 *   cat scripts/register-docs-in-pv.ts | ssh mars \
 *     "kubectl -n lgr exec -i deploy/lgr -- sh -c 'cd /app/packages/db && ORGSLUG=regal-pz EXECUTE=1 bun -'"
 */
const mongoose = require('mongoose')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { DocFile, Org, User, AuditLog } = require('./src/models')

const EXECUTE = process.env.EXECUTE === '1'
const ORGSLUG = process.env.ORGSLUG || 'regal-pz'

const PREFIX_TYPE: Record<string, string> = {
  invoicem: 'invoice', salesAnalysis: 'cash_register', stokrazp: 'goods_receipt',
  sklrazp: 'transfer_note', sklisk: 'issue_note', storeOperations: 'store_operations',
  storeAvailability: 'store_availability',
}
const XLSX_TYPES = new Set(['cash_register', 'store_operations', 'store_availability'])
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

function parseMeta(filename: string) {
  const base = filename.replace(/\.[^.]+$/, '')
  const m = base.match(/^([A-Za-z]+)_(.+)$/)
  const prefix = m?.[1] ?? ''
  const rest = m?.[2] ?? base
  const docType = PREFIX_TYPE[prefix] ?? 'unknown'
  if (XLSX_TYPES.has(docType)) return { docType, docNumber: rest }
  return { docType, docNumber: rest.replace(/[^0-9]/g, '') || rest }
}
const mimeFor = (n: string) => /\.pdf$/i.test(n) ? 'application/pdf'
  : /\.xlsx?$/i.test(n) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream'

;(async () => {
  await mongoose.connect(process.env.MONGODB_URI)
  const org: any = await Org.findOne({ slug: ORGSLUG }).lean()
  if (!org) { console.log(`org ${ORGSLUG} not found`); process.exit(1) }
  await require('./src/home/home').assertHomeIsHere(String(org._id), { fresh: true })  // FR-20.4: only on its home
  const orgId = String(org._id)
  const admin: any = await User.findOne({ orgId, role: 'admin' }).lean() || await User.findOne({ orgId }).lean()
  const uploadDir = process.env.UPLOAD_DIR || '/app/uploads'
  const root = path.join(uploadDir, orgId, 'docs')
  console.log(`org=${ORGSLUG} (${orgId})  root=${root}  uploadedBy=${admin?._id}  EXECUTE=${EXECUTE}`)

  if (!fs.existsSync(root)) { console.log('root does not exist — run the transfer first'); process.exit(1) }

  let registered = 0, skippedExisting = 0, skippedUnknown = 0, byType: Record<string, number> = {}, byDate: Record<string, number> = {}
  for (const dateDir of fs.readdirSync(root)) {
    if (!isDate(dateDir)) continue // skip inbox, __, non-date folders
    const dir = path.join(root, dateDir)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (!fs.statSync(full).isFile()) continue // skip versions/ etc.
      if (!/\.(pdf|xlsx?)$/i.test(name)) continue // skip compare-*.csv/txt
      const { docType, docNumber } = parseMeta(name)
      if (docType === 'unknown') { skippedUnknown++; continue } // invoiceProf (proforma) etc.

      const existing = await DocFile.findOne({ orgId, docType, docNumber }).lean()
      if (existing) { skippedExisting++; continue }

      const buf = fs.readFileSync(full)
      const checksum = crypto.createHash('sha256').update(buf).digest('hex')
      byType[docType] = (byType[docType] || 0) + 1
      byDate[dateDir] = (byDate[dateDir] || 0) + 1
      registered++
      if (EXECUTE) {
        const doc = await DocFile.create({
          orgId, docType, docNumber, docDate: dateDir, originalName: name, currentPath: full,
          currentChecksum: checksum, version: 1, mimeType: mimeFor(name), size: buf.length,
          status: 'uploaded', uploadedBy: admin?._id, uploadedAt: new Date(),
        })
        await AuditLog.create({
          orgId, userId: admin?._id, module: 'files', action: 'upload', entityType: 'DocFile',
          entityId: doc._id, entityName: name,
          changes: [{ field: 'source', oldValue: null, newValue: `_docs migration (${dateDir})` }],
        })
      }
    }
  }
  console.log(`\n${EXECUTE ? 'REGISTERED' : 'WOULD REGISTER'}: ${registered}   skipped(existing)=${skippedExisting}   skipped(unknown/proforma)=${skippedUnknown}`)
  console.log('by type:', JSON.stringify(byType))
  console.log('by date:', JSON.stringify(byDate))
  if (!EXECUTE) console.log('\nDRY-RUN — set EXECUTE=1 to write DocFile rows.')
  await mongoose.disconnect(); process.exit(0)
})()
