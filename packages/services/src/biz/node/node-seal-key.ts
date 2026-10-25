import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { config, nodeRole } from 'config'
import { NodeState } from 'db/models'
import { logger } from '../../logger/logger.js'
import { generateSealKey, isSealPublicKey, sealPublicKeyOf } from '../crypto/node-seal.js'

/**
 * A master's seal key (FR-20.40, plan step P2-4c): what lgrai.app seals its people's local
 * credentials to (`crypto/node-seal.ts`).
 *
 * - **Made here, once, kept in `NodeState`** (no `orgId`, so no bundle carries it, FR-20.21). It
 *   guards the verifiers on their way here, and the verifiers end up in this database anyway: a
 *   safer home for the key would protect nothing they do not already have.
 * - **The node key vouches for it.** Its public half goes to `config.node.sealPubFile`, and the
 *   supervisor puts that into the token assertions it signs with the node key (`seal` claim). Global
 *   records it only from there, so a proxy that sees a node token cannot swap in a key of its own.
 * - A master whose `NodeState` is lost makes a new key, and global seals to it from the next token
 *   the supervisor fetches (within ten minutes). Until then what global sends does not open, and the
 *   credential feed waits instead of moving on.
 */

const STATE_ID = 'seal-key'

/** This master's seal key, made on first use. Null off a master. */
export async function masterSealKey(): Promise<{ publicKey: string; privateKey: string } | null> {
  if (nodeRole() !== 'master') return null
  const found: any = await NodeState.findById(STATE_ID).lean().exec()
  const kept = found?.value
  if (typeof kept?.privateKey === 'string' && sealPublicKeyOf(kept.privateKey) === kept.publicKey) {
    return { publicKey: kept.publicKey, privateKey: kept.privateKey }
  }
  const made = generateSealKey()
  try {
    await NodeState.create({ _id: STATE_ID, value: { ...made, createdAt: new Date() } })
    logger.info('This master made its seal key (FR-20.40)')
    return made
  } catch (e: any) {
    if (e?.code !== 11000) throw e
  }
  // A row that is not a usable key is replaced; a concurrent first use is read back.
  const again: any = await NodeState.findById(STATE_ID).lean().exec()
  if (typeof again?.value?.privateKey === 'string' && sealPublicKeyOf(again.value.privateKey) === again.value.publicKey) {
    return { publicKey: again.value.publicKey, privateKey: again.value.privateKey }
  }
  await NodeState.updateOne({ _id: STATE_ID }, { $set: { value: { ...made, createdAt: new Date() } } }).exec()
  logger.warn('This master replaced an unusable seal key (FR-20.40)')
  return made
}

/** What the supervisor reads: `{v: 1, seal}`. */
function published(file: string): string | null {
  try {
    const seal = JSON.parse(readFileSync(file, 'utf8'))?.seal
    return isSealPublicKey(seal) ? seal : null
  } catch {
    return null
  }
}

/**
 * Make sure the supervisor can see this master's seal key: write its public half where it looks,
 * when it is not there already. Returns the key, or null off a master. Never throws for the file:
 * the credential feed then waits, and the next pass tries again.
 */
export async function publishSealKey(file = config.node.sealPubFile): Promise<{ publicKey: string; privateKey: string } | null> {
  const key = await masterSealKey()
  if (!key || !file || published(file) === key.publicKey) return key
  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ v: 1, seal: key.publicKey }), { mode: 0o600 })
    renameSync(tmp, file)
    logger.info('This master published its seal key for the supervisor to sign (FR-20.40)')
  } catch (e) {
    logger.warn({ err: e, file }, 'Could not publish this master\'s seal key; the credential feed waits')
  }
  return key
}
