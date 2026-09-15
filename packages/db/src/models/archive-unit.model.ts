import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

/**
 * FR-13.38–13.42 (#24) — one packed fiscal year of an org's document bytes.
 *
 * ⚠ The unit is a LOCKED FISCAL YEAR, never an age. Age alone would pack away the documents
 * of a year still being corrected; `locked` is the organisation stating it is finished with
 * that year. `config.archive.horizonYears` is the additional grace on top.
 *
 * ⚠ This row is the INDEX of the archive, and it is the thing that makes the archive legal.
 * Приложение 29 т. 16 requires archived data to stay reachable „през потребителски
 * интерфейс" and т. 19 requires the `nra_auditor` profile to reach it — so the `DocFile` rows
 * stay live and listed, and this row is how a listed document finds its bytes again. A
 * tarball in a bucket with no row pointing at it is exactly the design the ordinance forbids.
 *
 * ⚠ Rows are NEVER archived, only bytes (FR-13.40). The database grows 169 MB/yr; `docs/`
 * grows 0.68 GB/yr against a 5 Gi PV and crosses it in year 7. Moving rows would cost
 * compliance and save nothing measurable.
 */
export interface IArchiveUnit extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  /** The `FiscalYear` this unit packs. */
  fiscalYearId: Types.ObjectId
  /** Its `name`, denormalised so the Archives list reads without a join. */
  fiscalYearName: string
  /** Inclusive `YYYY-MM-DD` bounds of the documents inside, for the coverage column. */
  coversFrom: string
  coversTo: string
  /** Path of the artifact RELATIVE to `UPLOAD_DIR`, so a restore onto another host works. */
  path: string
  filename: string
  /** sha256 of the COMPRESSED artifact — what proves the unit itself is intact. */
  sha256: string
  /** Size of the artifact on disk. */
  bytes: number
  /** Number of files inside. */
  fileCount: number
  /** Total size of the packed files before compression, for the ratio the UI shows. */
  contentBytes: number
  /**
   * ⚠ `packed` means the loose files were removed. `verified` means every file's sha256 was
   * reproduced from the artifact and matched `DocFile.currentChecksum` — and NOTHING is
   * deleted before that. An archive that has not proven it can give the bytes back is not an
   * archive, it is a deletion with extra steps.
   */
  status: 'building' | 'verified' | 'packed' | 'failed'
  reason?: string
  /**
   * Off-site copies, same shape the backup runner records.
   *
   * ⚠ Every field the destination service returns is declared here. Mongoose drops unknown
   * paths from a subdocument SILENTLY, so a field the push produced and the schema did not
   * name (the object key, the read-back verification, the Object Lock retain-until that rides
   * in `reason`) would be written, discarded, and missing from the one record that says where
   * a fiscal year's cold copy went.
   */
  destinations?: Array<{
    name: string
    status: string
    at?: Date
    remoteId?: string
    reason?: string
    /** The remote name or object key — what an operator searches the destination for. */
    filename?: string
    bytes?: number
    /** SHA-256 over the SEALED artifact, as uploaded. */
    sha256?: string
    /** Read back from the destination and re-hashed, rather than assumed from a 200. */
    verified?: boolean
    prunedCount?: number
  }>
  createdBy?: Types.ObjectId
  completedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const archiveUnitSchema = new Schema<IArchiveUnit>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    fiscalYearId: { type: Schema.Types.ObjectId, ref: 'FiscalYear', required: true },
    fiscalYearName: { type: String, required: true },
    coversFrom: { type: String, required: true },
    coversTo: { type: String, required: true },
    path: String,
    filename: String,
    sha256: String,
    bytes: Number,
    fileCount: { type: Number, default: 0 },
    contentBytes: { type: Number, default: 0 },
    status: { type: String, required: true, default: 'building', enum: ['building', 'verified', 'packed', 'failed'] },
    reason: String,
    destinations: [{
      name: String,
      status: String,
      at: Date,
      remoteId: String,
      reason: String,
      filename: String,
      bytes: Number,
      sha256: String,
      verified: Boolean,
      prunedCount: Number,
    }],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    completedAt: Date,
  },
  { timestamps: true },
)

archiveUnitSchema.plugin(tenantPlugin)

/**
 * The claim: one unit per fiscal year per org. Same lesson as `BackupRun` — the index IS the
 * lock, there is no queue or lease in this codebase, and two packers running on the same year
 * would each delete the loose files the other is still reading.
 */
archiveUnitSchema.index({ orgId: 1, fiscalYearId: 1 }, { unique: true })
/** The Archives tab reads newest-first per org. */
archiveUnitSchema.index({ orgId: 1, createdAt: -1 })

export const ArchiveUnit = model<IArchiveUnit>('ArchiveUnit', archiveUnitSchema)
