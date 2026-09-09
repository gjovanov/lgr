#!/usr/bin/env bun
/**
 * FR-13.23/13.56 (#24) — the operator's half of bundle sealing.
 *
 * The cluster gets a WRITE-ONLY key: it can seal a bundle and cannot open one. This script is
 * where the pair is made and where a sealed artifact is opened again, and it must be run
 * somewhere that is NOT mars and NOT a cluster node — the private half exists precisely so
 * that whoever reaches the cluster cannot read the backups.
 *
 *   bun scripts/backup-crypto.ts keygen
 *   bun scripts/backup-crypto.ts inspect  <artifact.sealed>
 *   bun scripts/backup-crypto.ts decrypt  <artifact.sealed> <output> [--identity-file key.txt]
 *
 * ⚠ An encrypted backup whose key is lost with the cluster is not a backup. Put the private
 * half in the password manager the moment it is generated, next to Layer 1's `age` key
 * (lgr-deploy/docs/BACKUP-RUNBOOK.md §8).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import {
  generateBackupKeyPair,
  readSealedHeader,
  unsealBundle,
} from '../packages/services/src/biz/backup/backup-crypto.js'

const [cmd, ...rest] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`)
  return i === -1 ? undefined : rest[i + 1]
}
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')))

function usage(): never {
  console.log(`
LGR backup sealing — FR-13.23/13.56

  keygen [--out <file>]                    generate a recipient/identity pair
           --out writes the PRIVATE half to <file> instead of printing it,
           which keeps it out of scrollback, shell history and CI logs
  inspect  <artifact>                      read the header WITHOUT the private key
  decrypt  <artifact> <output>             open a sealed artifact
           [--identity-file <path>]        (or set BACKUP_ENCRYPTION_PRIVATE_KEY)

⚠ Run this OFF the cluster. The private key must never live on mars or a cluster node.
`)
  process.exit(1)
}

if (cmd === 'keygen') {
  const { publicKey, privateKey } = generateBackupKeyPair()
  const out = flag('out')

  console.log('\n── PUBLIC (recipient) — goes on the cluster, in lgr-secret ────────────────')
  console.log(`BACKUP_ENCRYPTION_PUBLIC_KEY=${publicKey}`)

  if (out) {
    // ⚠ `--out` exists so the private half never reaches stdout, and that is not fussiness:
    // a terminal keeps scrollback, a shell keeps history, a CI job keeps logs, and an agent
    // session keeps a transcript. A key printed once is a key stored in four places nobody
    // is thinking about. `age-keygen -o` makes the same choice for the same reason.
    writeFileSync(out, privateKey + '\n', { mode: 0o600 })
    console.log(`\n── PRIVATE (identity) ────────────────────────────────────────────────────`)
    console.log(`written to ${out} — it was NOT printed`)
    console.log('\n⚠ Copy it into the password manager and keep it off every cluster node.')
    console.log('  Without it every sealed backup is unreadable, including by us.\n')
  } else {
    console.log('\n── PRIVATE (identity) — password manager ONLY, never on any cluster node ──')
    console.log(privateKey)
    console.log('\n⚠ This private half is shown once and stored nowhere. Without it, every sealed')
    console.log('  backup is unreadable — including by us. Save it before closing this terminal.')
    console.log('  ⚠ It is now in this terminal\'s scrollback and your shell history. Prefer')
    console.log('    `keygen --out <file>`, which never prints it.\n')
  }
} else if (cmd === 'inspect') {
  const path = positional[0]
  if (!path) usage()
  const header = readSealedHeader(readFileSync(path))
  console.log(JSON.stringify(header, null, 2))
  console.log(`\nSealed to recipient: ${header.recipient}`)
  console.log(`Plaintext: ${header.plainBytes} bytes, sha256 ${header.plainSha256}`)
} else if (cmd === 'decrypt') {
  const [input, output] = positional
  if (!input || !output) usage()
  const idFile = flag('identity-file')
  const identity = (idFile ? readFileSync(idFile, 'utf8') : process.env.BACKUP_ENCRYPTION_PRIVATE_KEY || '').trim()
  if (!identity) {
    console.error('No identity. Pass --identity-file <path> or set BACKUP_ENCRYPTION_PRIVATE_KEY.')
    process.exit(1)
  }
  const plain = unsealBundle(readFileSync(input), identity)
  writeFileSync(output, plain)
  console.log(`Opened ${input} → ${output} (${plain.length} bytes, checksum verified)`)
  console.log(`Read it with:  zstd -dc ${output} | head -1 | jq .manifest`)
} else {
  usage()
}
