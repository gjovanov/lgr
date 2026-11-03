import { PersonalDataKey } from 'db/models'
import { clearVaultCache, forOrg, keyRowOpens, PersonalDataLockedError, vaultFromRow } from './personal-data.service.js'

/**
 * FR-25 §3.12: what a restore must do about sealed values.
 *
 * ⚠ A value is bound to the document it was sealed on. Restoring a bundle into another org gives
 * every document a new `_id`, so its values would stop opening. They are re-sealed here, from the
 * bundle's key row to the target's keys, rather than loosening what the binding protects.
 */
const KEY_MODEL = 'PersonalDataKey'

/** Model → the path holding one sealed JSON. New sealed models join here, or a remap breaks them. */
export const SEALED_PATHS: Readonly<Record<string, string>> = {
  Employee: 'personal',
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
  const holdsSealed = Object.entries(SEALED_PATHS).some(([model, path]) => (byCollection.get(model) ?? []).some(d => d?.[path]))
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
      const path = SEALED_PATHS[name]
      if (!remapTo || !path || !rawDocs.some(d => d?.[path])) return docs
      const from = vaultFromRow(bundleRow)
      const to = await forOrg(remapTo)
      return docs.map((doc, i) => {
        const sealed = rawDocs[i]?.[path]
        if (!sealed) return doc
        // `docs[i]` is `rawDocs[i]` rewritten: the origin's id opens it, the new one seals it.
        const value = from.open(name, String(rawDocs[i]._id), path, sealed)
        return { ...doc, [path]: to.seal(name, String(doc._id), path, value), ...reindexed(name, to, value) }
      })
    },

    finished(orgId) {
      clearVaultCache(orgId)
    },
  }
}

/** A lookup value belongs to the keys it was made with, so a re-sealed row needs a new one. */
function reindexed(name: string, vault: { blindIndex(field: string, value: string): string }, value: any): Record<string, string> {
  return name === 'Employee' && value?.nationalId ? { nationalIdHmac: vault.blindIndex('nationalId', String(value.nationalId)) } : {}
}
