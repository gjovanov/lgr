#!/usr/bin/env bun
/**
 * FR-25 §3.12: the key that wraps every org's personal-data keys. The runbook is
 * docs/guides/personal-data-key.md.
 *
 *   bun scripts/personal-data-key.ts generate --out <env-file> --escrow <file>
 *       New KEK. Written to <env-file> and sealed to BACKUP_ENCRYPTION_PUBLIC_KEY in <file>.
 *       ⚠ Never printed: it would land in a terminal's scrollback and a transcript.
 *   bun scripts/personal-data-key.ts verify --env <env-file> --escrow <file> --identity <seal-key-file>
 *       Opens the escrow with the private half and proves it is the same KEK.
 *   bun --env-file=.env scripts/personal-data-key.ts check
 *       Does this KEK open every org's keys? Reads only.
 *   bun --env-file=.env scripts/personal-data-key.ts rewrap [--execute]
 *       After a rotation: rewraps every org's keys with PERSONAL_DATA_KEK, using
 *       PERSONAL_DATA_KEK_PREVIOUS to open them. Dry-run by default. Touches no data.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { sealBundle, unsealBundle } from '../packages/services/src/biz/backup/backup-crypto'
import { generateKey, kekIdOf, parseKek } from '../packages/services/src/biz/personal-data/crypto'

const [command, ...rest] = process.argv.slice(2)
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : undefined
}
const required = (name: string) => {
  const value = flag(name)
  if (!value) die(`--${name} is required`)
  return value as string
}
function die(message: string): never {
  console.error(message)
  process.exit(1)
}
const readKekFile = (path: string) => {
  const line = readFileSync(path, 'utf8').split(/\r?\n/).find(l => l.startsWith('PERSONAL_DATA_KEK='))
  if (!line) die(`${path} holds no PERSONAL_DATA_KEK line`)
  return parseKek((line as string).slice('PERSONAL_DATA_KEK='.length))
}

if (command === 'generate') {
  const out = required('out')
  const escrow = required('escrow')
  const publicKey = (flag('public-key') ?? process.env.BACKUP_ENCRYPTION_PUBLIC_KEY ?? '').trim()
  if (!publicKey) die('BACKUP_ENCRYPTION_PUBLIC_KEY is not set: a KEK with no escrow is one lost laptop from losing everything')
  for (const path of [out, escrow]) if (existsSync(path)) die(`${path} already exists. A second key would orphan what the first one wrapped, so it is not overwritten`)
  const kek = generateKey()
  writeFileSync(escrow, sealBundle(kek, publicKey))
  writeFileSync(out, `PERSONAL_DATA_KEK=${kek.toString('base64')}\n`, { mode: 0o600 })
  console.log(`generated KEK ${kekIdOf(kek)}, escrow sealed to the backup key. Now seal it into the deployment and verify the escrow.`)
} else if (command === 'verify') {
  const kek = readKekFile(required('env'))
  const identity = readFileSync(required('identity'), 'utf8').trim()
  const opened = unsealBundle(readFileSync(required('escrow')), identity)
  if (!opened.equals(kek)) die(`the escrow does NOT hold this KEK (${kekIdOf(kek)} against ${kekIdOf(opened)})`)
  console.log(`escrow opens and holds KEK ${kekIdOf(kek)}`)
} else if (command === 'check' || command === 'rewrap') {
  const { mongoose } = await import('../packages/db/src/connection')
  const { PersonalDataKey } = await import('../packages/db/src/models/personal-data-key.model')
  const { config } = await import('../packages/config/src/index')
  const service = await import('../packages/services/src/biz/personal-data/personal-data.service')
  const { tenantHomeScope } = await import('./lib/home-guard')
  await mongoose.connect(config.mongodb.uri, { autoIndex: false, autoCreate: false })
  try {
    if (command === 'check') {
      const status = await service.checkPersonalDataKeys()
      console.log(`KEK present: ${status.keyPresent}; orgs with keys: ${status.orgs}; orgs it cannot open: ${status.unopenable.length}`)
      if (status.unopenable.length) process.exitCode = 1
    } else if (!rest.includes('--execute')) {
      const current = kekIdOf(parseKek(config.personalData.kek ?? die('PERSONAL_DATA_KEK is not set')))
      const rows: any[] = await PersonalDataKey.find(await tenantHomeScope(), { kekId: 1 }).lean().exec()
      console.log(`dry run: ${rows.filter(r => r.kekId !== current).length} of ${rows.length} orgs would be rewrapped to ${current}. --execute to do it`)
    } else {
      console.log(await service.rewrapKeyRows(await tenantHomeScope()))
    }
  } finally {
    await mongoose.disconnect()
  }
} else {
  die('usage: personal-data-key.ts generate | verify | check | rewrap (see the header of this file)')
}
