import { PersonalDataKey } from 'db/models'
import { runItemPath } from './crypto.js'
import { clearVaultCache, forOrg, keyRowOpens, PersonalDataLockedError, vaultFromRow, type OrgVault } from './personal-data.service.js'

/**
 * FR-25 §3.12: what a restore must do about sealed values.
 *
 * ⚠ A value is bound to the document it was sealed on. Restoring a bundle into another org gives
 * every document a new `_id`, so its values would stop opening. They are re-sealed here, from the
 * bundle's key row to the target's keys, rather than loosening what the binding protects.
 */
const KEY_MODEL = 'PersonalDataKey'

/** One sealed JSON on the document, or one on each entry of a list, under a path of its own. */
type SealedLocation =
  | { path: string }
  | { list: string; value: string; pathOf: (entry: any) => string }

/** Where a model keeps sealed values. New sealed models join here, or a remap breaks them. */
export const SEALED_PATHS: Readonly<Record<string, readonly SealedLocation[]>> = {
  Employee: [{ path: 'personal' }],
  EmploymentContract: [{ path: 'pay' }],
  AbsenceEntry: [{ path: 'detail' }],
  Payslip: [{ path: 'sealed' }],
  PayrollRun: [{ path: 'filed' }, { list: 'sealedItems', value: 'sealed', pathOf: runItemPath }],
}

function holdsValue(doc: any, location: SealedLocation): boolean {
  if ('path' in location) return !!doc?.[location.path]
  return (doc?.[location.list] ?? []).some((entry: any) => entry?.[location.value])
}

export interface PersonalDataRestore {
  /** The documents to write for this model, re-sealed when ids changed. */
  prepare(name: string, rawDocs: any[], docs: any[]): Promise<any[]>
  /** True when this section must not be written the ordinary way. */
  handlesKeyRow(name: string): boolean
  /** Applies the bundle's key row. Returns what it did, for the restore's report. */
  applyKeyRow(orgId: string): Promise<{ inserted: number; merged: number }>
  /** Call once the restore has written, so no process keeps serving keys it opened before. */
  finished(orgId: string): void
}

/**
 * Called before a single write. Refuses a bundle whose personal data would come back unreadable on
 * this server, rather than restoring a company's payroll into something nobody can open.
 */
export async function planPersonalDataRestore(
  byCollection: Map<string, any[]>,
  /** The org the documents are being rewritten onto, or null when they keep their ids. */
  remapTo: string | null,
): Promise<PersonalDataRestore> {
  const bundleRow = (byCollection.get(KEY_MODEL) ?? [])[0]
  const holdsSealed = Object.entries(SEALED_PATHS).some(([model, locations]) =>
    (byCollection.get(model) ?? []).some(doc => locations.some(location => holdsValue(doc, location))))
  if (holdsSealed && !bundleRow) {
    throw new PersonalDataLockedError('this bundle holds sealed personal data but not the keys for it')
  }
  if (bundleRow && !keyRowOpens(bundleRow)) {
    throw new PersonalDataLockedError('this server\'s PERSONAL_DATA_KEK cannot open this bundle\'s keys. Set the key it was made with (see the escrow runbook), then restore')
  }

  return {
    handlesKeyRow: name => name === KEY_MODEL,

    async applyKeyRow(orgId) {
      // A remap re-seals every value under the target's own keys, so the bundle's row stays behind.
      if (!bundleRow || remapTo) return { inserted: 0, merged: 0 }
      const live: any = await PersonalDataKey.findOne({ orgId }).lean().exec()
      if (!live) {
        await PersonalDataKey.collection.insertOne(bundleRow)
        return { inserted: 1, merged: 0 }
      }
      // The org's keys were replaced since this bundle. Both sets stay, or its values would not open.
      const known = new Set((live.keys ?? []).map((k: any) => k.keyId))
      const missing = (bundleRow.keys ?? []).filter((k: any) => !known.has(k.keyId)).map((k: any) => ({ ...k, status: 'retired' }))
      if (missing.length) await PersonalDataKey.updateOne({ _id: live._id }, { $push: { keys: { $each: missing } } }).exec()
      return { inserted: 0, merged: missing.length }
    },

    async prepare(name, rawDocs, docs) {
      const locations = SEALED_PATHS[name]
      if (!remapTo || !locations || !rawDocs.some(doc => locations.some(location => holdsValue(doc, location)))) return docs
      const from = vaultFromRow(bundleRow)
      const to = await forOrg(remapTo)
      // `docs[i]` is `rawDocs[i]` rewritten: the origin's id opens a value, the new one seals it.
      return docs.map((doc, i) => locations.reduce((out, location) => resealed(name, location, rawDocs[i], out, from, to), doc))
    },

    finished(orgId) {
      clearVaultCache(orgId)
    },
  }
}

function resealed(name: string, location: SealedLocation, raw: any, doc: any, from: OrgVault, to: OrgVault): any {
  const rawId = String(raw?._id)
  const newId = String(doc._id)
  if ('path' in location) {
    const sealed = raw?.[location.path]
    if (!sealed) return doc
    const value = from.open(name, rawId, location.path, sealed)
    return { ...doc, [location.path]: to.seal(name, newId, location.path, value), ...reindexed(name, to, value) }
  }
  const rawEntries: any[] = raw?.[location.list] ?? []
  const entries = (doc[location.list] ?? []).map((entry: any, j: number) => {
    const sealed = rawEntries[j]?.[location.value]
    if (!sealed) return entry
    const value = from.open(name, rawId, location.pathOf(rawEntries[j]), sealed)
    return { ...entry, [location.value]: to.seal(name, newId, location.pathOf(entry), value) }
  })
  return { ...doc, [location.list]: entries }
}

/** A lookup value belongs to the keys it was made with, so a re-sealed row needs a new one. */
function reindexed(name: string, vault: { blindIndex(field: string, value: string): string }, value: any): Record<string, string> {
  return name === 'Employee' && value?.nationalId ? { nationalIdHmac: vault.blindIndex('nationalId', String(value.nationalId)) } : {}
}
