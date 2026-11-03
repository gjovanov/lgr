import { config } from 'config'
import { PersonalDataKey } from 'db/models'
import { logger } from '../../logger/logger.js'
import {
  aadFor, blindIndex, CANARY, generateKey, generateKeyId, keyIdOf, kekIdOf, open, parseKek, seal, unwrapKey, wrapKey,
} from './crypto.js'

/**
 * FR-25 §3.12: an org's keys, opened on demand, and the only door to its personal data.
 *
 * ⚠ Nothing decrypts by itself. A repository returns ciphertext, so a forgotten projection leaks
 * only ciphertext; whoever wants a value asks here for the org's vault and says which document and
 * field it is for.
 *
 * ⚠ A missing or wrong key is LOUD: `PersonalDataLockedError`, which a route answers as 503. Never a
 * blank where a value was, and never a value stored in clear because the key was not there.
 */
export class PersonalDataLockedError extends Error {
  readonly code = 'personal_data_locked'
  readonly statusCode = 503
  constructor(reason: string) {
    super(`Personal data is locked: ${reason}`)
    this.name = 'PersonalDataLockedError'
  }
}

export interface OrgVault {
  seal(model: string, docId: string, path: string, value: unknown): string
  open<T = unknown>(model: string, docId: string, path: string, sealed: string): T
  blindIndex(field: string, value: string): string
}

interface OpenedKeys {
  active: { keyId: string; key: Buffer }
  byId: Map<string, Buffer>
  indexKey: Buffer
}

/** How long opened keys stay in this process. A rotation elsewhere is picked up after this. */
const VAULT_TTL_MS = 5 * 60 * 1000
const vaults = new Map<string, { vault: OrgVault; at: number }>()

export function clearVaultCache(orgId?: string): void {
  if (orgId) vaults.delete(String(orgId))
  else vaults.clear()
}

function configuredKeks(): Buffer[] {
  const { kek, previousKek } = config.personalData
  return [kek, previousKek].filter((k): k is string => !!k).map(parseKek)
}

export function personalDataKeyPresent(): boolean {
  return !!config.personalData.kek
}

function currentKek(): Buffer {
  if (!config.personalData.kek) throw new PersonalDataLockedError('PERSONAL_DATA_KEK is not set on this server')
  return parseKek(config.personalData.kek)
}

const canaryAad = (keyId: string) => aadFor(keyId, 'PersonalDataKey', 'canary', 'canary')

/** Tries each configured KEK: during a KEK rotation a row may still be wrapped by the previous one. */
function openRow(row: any): OpenedKeys {
  const keks = configuredKeks()
  if (!keks.length) throw new PersonalDataLockedError('PERSONAL_DATA_KEK is not set on this server')
  for (const kek of keks) {
    try {
      const byId = new Map<string, Buffer>()
      for (const entry of row.keys ?? []) byId.set(entry.keyId, unwrapKey(kek, entry.wrapped, 'dek'))
      const activeEntry = (row.keys ?? []).find((k: any) => k.status === 'active')
      if (!activeEntry) throw new Error('no active key')
      const indexKey = unwrapKey(kek, row.indexKey, 'index')
      const canaryKeyId = keyIdOf(row.canary)
      const canaryKey = byId.get(canaryKeyId)
      if (!canaryKey || open(canaryKey, row.canary, canaryAad(canaryKeyId)) !== CANARY) throw new Error('canary mismatch')
      return { active: { keyId: activeEntry.keyId, key: byId.get(activeEntry.keyId)! }, byId, indexKey }
    } catch { /* the next configured KEK, if any */ }
  }
  throw new PersonalDataLockedError('the configured key cannot open this org\'s keys')
}

export function newKeyRow(orgId: unknown, kek: Buffer) {
  const keyId = generateKeyId()
  const dek = generateKey()
  return {
    orgId,
    kekId: kekIdOf(kek),
    keys: [{ keyId, wrapped: wrapKey(kek, keyId, 'dek', dek), status: 'active' as const, createdAt: new Date() }],
    indexKey: wrapKey(kek, generateKeyId(), 'index', generateKey()),
    canary: seal(dek, keyId, CANARY, canaryAad(keyId)),
  }
}

function vaultOver(keys: OpenedKeys): OrgVault {
  return {
    seal(model, docId, path, value) {
      return seal(keys.active.key, keys.active.keyId, JSON.stringify(value), aadFor(keys.active.keyId, model, docId, path))
    },
    open<T>(model: string, docId: string, path: string, sealed: string): T {
      const keyId = keyIdOf(sealed)
      const key = keys.byId.get(keyId)
      if (!key) throw new PersonalDataLockedError(`this org has no key ${keyId}`)
      try {
        return JSON.parse(open(key, sealed, aadFor(keyId, model, docId, path))) as T
      } catch (e) {
        if (e instanceof PersonalDataLockedError) throw e
        // Not "locked": the key is right and this value does not belong here. Worth saying apart.
        throw new Error(`A sealed value on ${model} ${docId} (${path}) does not open: it was altered or moved`)
      }
    },
    blindIndex(field, value) {
      return blindIndex(keys.indexKey, field, value)
    },
  }
}

/**
 * The org's vault. Creates its keys on first use, so an org with no employees has no key row and an
 * org cannot exist half-keyed. `PersonalDataLockedError` when this server cannot open them.
 */
export async function forOrg(orgId: unknown): Promise<OrgVault> {
  const id = String(orgId)
  const cached = vaults.get(id)
  if (cached && Date.now() - cached.at < VAULT_TTL_MS) return cached.vault

  let row: any = await PersonalDataKey.findOne({ orgId: id }).lean().exec()
  if (!row) {
    const fresh = newKeyRow(id, currentKek())
    try {
      await PersonalDataKey.create(fresh)
      row = fresh
    } catch (e: any) {
      if (e?.code !== 11000) throw e
      // Another pod made the row first: theirs is the one, or two keys would be in use.
      row = await PersonalDataKey.findOne({ orgId: id }).lean().exec()
    }
  }
  const vault = vaultOver(openRow(row))
  vaults.set(id, { vault, at: Date.now() })
  return vault
}

export interface PersonalDataStatus {
  keyPresent: boolean
  orgs: number
  /** Orgs whose keys this server cannot open. Their personal data is out of reach until it can. */
  unopenable: string[]
}

let lastStatus: PersonalDataStatus = { keyPresent: false, orgs: 0, unopenable: [] }

export function personalDataStatus(): PersonalDataStatus {
  return lastStatus
}

/** At startup: every key row this server holds opens, or an operator hears about it now. */
export async function checkPersonalDataKeys(): Promise<PersonalDataStatus> {
  const rows: any[] = await PersonalDataKey.find({}).lean().exec()
  const unopenable: string[] = []
  for (const row of rows) {
    try { openRow(row) } catch { unopenable.push(String(row.orgId)) }
  }
  lastStatus = { keyPresent: personalDataKeyPresent(), orgs: rows.length, unopenable }
  if (unopenable.length) {
    logger.error({ orgs: unopenable.length, keyPresent: lastStatus.keyPresent }, 'Personal data: this server cannot open the keys of some orgs. Their personal data is locked until the right PERSONAL_DATA_KEK is set')
  } else if (!lastStatus.keyPresent) {
    logger.warn('PERSONAL_DATA_KEK is not set: personal data cannot be written or read on this server')
  }
  return lastStatus
}

/**
 * Whether a backup's key row opens here, without changing anything. A restore asks this first, so
 * that it refuses a bundle whose personal data would come back unreadable.
 */
export function keyRowOpens(row: unknown): boolean {
  try { openRow(row); return true } catch { return false }
}

/** A key row's keys opened as a vault, for reading values out of a bundle during a remapped restore. */
export function vaultFromRow(row: unknown): OrgVault {
  return vaultOver(openRow(row))
}

/**
 * KEK rotation: rewraps every key row in `scope` with the current KEK. Touches no data. Returns how
 * many. ⚠ A row homed on another node is refused by the write guard, half way through a rotation:
 * a script passes `tenantHomeScope()`, and that node rotates its own.
 */
export async function rewrapKeyRows(scope: Record<string, unknown> = {}): Promise<{ rewrapped: number; alreadyCurrent: number }> {
  const kek = currentKek()
  const keks = configuredKeks()
  const kekId = kekIdOf(kek)
  const rows: any[] = await PersonalDataKey.find(scope).lean().exec()
  let rewrapped = 0
  let alreadyCurrent = 0
  for (const row of rows) {
    if (row.kekId === kekId) { alreadyCurrent++; continue }
    const opener = keks.find(k => {
      try { unwrapKey(k, row.indexKey, 'index'); return true } catch { return false }
    })
    if (!opener) throw new PersonalDataLockedError(`no configured key opens org ${row.orgId}`)
    const indexKeyId = keyIdOf(row.indexKey)
    await PersonalDataKey.updateOne({ _id: row._id }, {
      $set: {
        kekId,
        indexKey: wrapKey(kek, indexKeyId, 'index', unwrapKey(opener, row.indexKey, 'index')),
        keys: row.keys.map((k: any) => ({ ...k, wrapped: wrapKey(kek, k.keyId, 'dek', unwrapKey(opener, k.wrapped, 'dek')) })),
      },
    }).exec()
    rewrapped++
  }
  clearVaultCache()
  return { rewrapped, alreadyCurrent }
}
