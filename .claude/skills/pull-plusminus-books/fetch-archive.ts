#!/usr/bin/env bun
// fetch-archive.ts — copy one of the books PC's nightly PlusMinus archives (`<install>\archive\<yyyymmdd>.arz`) here, byte-exact,
// and SEAL it on arrival. Read-only on that PC: it lists the archive folder and reads one file with FileShare.ReadWrite. Nothing else.
//
//   bun fetch-archive.ts --list                 the newest archives on the PC, and whether PlusMinus is open there
//   bun fetch-archive.ts [--name 20261105.arz]  fetch that one (default: the newest COMPLETE one), seal it, keep the last --keep (14)
//
// Why sealed: the archive is the WHOLE database of the accountant's install: books, and payroll with every employee's ЕГН and pay.
// It is written to disk only as `lgr-sealed-1` (BACKUP_ENCRYPTION_PUBLIC_KEY, the same seal the payroll pulls use); the plaintext lives
// in memory and, for the length of one run, in the sandbox server's own folder (see pull-books.ts).
//
// Transport: ONE `roomler ssh` call carries the whole file as base64 in 1 MB lines (49.9 MB in 77 s, 2026-11-05). `roomler exec`
// caps a call's whole output near 256 KB, so it is not used for the bytes. The SHA-256 is computed on the PC in the same call that
// reads the bytes, and must equal ours.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'
import { need } from '../pull-plusminus-api/stores-env'
import { sealBundle } from '../../../packages/services/src/biz/backup/backup-crypto'
import { sealKey } from './seal-key'

const args = process.argv.slice(2)
const flag = (f: string) => args.includes(f)
const opt = (f: string, d?: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d }

const agent = need('ACC_ROOMLER_AGENT'), pmRoot = need('ACC_PM_ROOT')
const dest = opt('--dest') ?? join(need('ACC_DOCS_ROOT'), 'archives')
const keep = Number(opt('--keep', '14'))
const minAgeMin = Number(opt('--min-age-min', '3'))
const NAME_RE = /^\d{8}\.arz$/ // the automatic archive; hand-made copies ("20261030 – Копие.arz") are never taken

function ps(body: string, timeoutMs: number): string {
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\n$root='${pmRoot.replaceAll("'", "''")}'\n` + body
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  for (let t = 1; t <= 5; t++) {
    const r = spawnSync('roomler', ['ssh', agent, '--', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
      { encoding: 'latin1', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = (r.stdout ?? '').replace(/\r/g, '')
    if (/too many ssh requests|rate.?limit/i.test(out + (r.stderr ?? ''))) { Bun.sleepSync(t * 15000); continue }
    if (out.includes('\nEND')) return out
    console.error(`fetch-archive: roomler ssh attempt ${t} gave no END (exit ${r.status}${r.error ? ', ' + r.error.message : ''}); retrying`)
    Bun.sleepSync(t * 5000)
  }
  throw new Error('roomler ssh kept failing; is the books PC online? (roomler devices -q "$ACC_STORE_PC")')
}

/** Streams the whole gzip through zlib (CRC + length trailer checked) without holding the ~1 GB it unpacks to. */
function gunzipLength(buf: Buffer): Promise<number> {
  return new Promise((ok, fail) => {
    let total = 0
    const z = createGunzip()
    z.on('data', (c: Buffer) => { total += c.length })
    z.on('end', () => ok(total))
    z.on('error', fail)
    z.end(buf)
  })
}

type Remote = { name: string; size: number; mtime: Date }
function list(): { archives: Remote[]; now: Date; pmOpen: number } {
  const out = ps(`$a = Join-Path $root 'archive'
Get-ChildItem -LiteralPath $a -File -Force | Where-Object { $_.Name -match '^\\d{8}\\.arz$' } | Sort-Object Name -Descending | Select-Object -First 10 |
  ForEach-Object { 'A ' + $_.Name + ' ' + $_.Length + ' ' + $_.LastWriteTimeUtc.ToString('o') }
'NOW ' + (Get-Date).ToUniversalTime().ToString('o')
'PM ' + @(Get-Process -Name plusminus -ErrorAction SilentlyContinue).Count
'END'`, 120000)
  const archives = [...out.matchAll(/^A (\S+) (\d+) (\S+)$/gm)].map(m => ({ name: m[1], size: Number(m[2]), mtime: new Date(m[3]) }))
  const now = new Date(out.match(/^NOW (\S+)$/m)![1])
  return { archives, now, pmOpen: Number(out.match(/^PM (\d+)$/m)?.[1] ?? 0) }
}

const { archives, now, pmOpen } = list()
if (flag('--list')) {
  for (const a of archives) console.log(`${a.name}  ${String(a.size).padStart(10)}  ${a.mtime.toISOString()}`)
  console.log(`PlusMinus processes on the PC: ${pmOpen}${pmOpen ? ' (open: today\'s archive is written when it closes)' : ''}`)
  process.exit(0)
}

// The newest COMPLETE archive: PlusMinus writes it when the day's session closes, so one still being written is skipped by age.
const want = opt('--name')
const pick = want ? archives.find(a => a.name === want) : archives.find(a => now.getTime() - a.mtime.getTime() > minAgeMin * 60000)
if (!pick) { console.error(`fetch-archive: ${want ? `no ${want} among the newest archives` : 'no archive older than ' + minAgeMin + ' min'} on the PC. --list shows them.`); process.exit(2) }
if (want && !NAME_RE.test(want)) { console.error('fetch-archive: --name must be <yyyymmdd>.arz'); process.exit(2) }

mkdirSync(dest, { recursive: true })
const target = join(dest, pick.name + '.sealed'), marker = target + '.sha'

const out = ps(`$p = Join-Path (Join-Path $root 'archive') '${pick.name}'
$f = [IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
$len = [int]$f.Length; $b = New-Object byte[] $len; $n = 0
while ($n -lt $len) { $r = $f.Read($b, $n, $len - $n); if ($r -le 0) { break }; $n += $r }
$f.Close()
$h = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b, 0, $n)).Replace('-','')
'N:' + $n
'SHA:' + $h
if ('${existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''}' -eq $h) { 'SAME'; 'END'; return }
$s = [Convert]::ToBase64String($b, 0, $n)
for ($i = 0; $i -lt $s.Length; $i += 1048576) { 'B:' + $s.Substring($i, [Math]::Min(1048576, $s.Length - $i)) }
'END'`, 900000)

const n = Number(out.match(/^N:(\d+)$/m)?.[1] ?? -1), sha = out.match(/^SHA:([0-9A-F]{64})$/m)?.[1]
if (!sha || n !== pick.size) throw new Error(`fetch-archive: the PC read ${n} bytes of ${pick.name}, listed as ${pick.size}`)
if (/^SAME$/m.test(out)) { console.log(`same      ${pick.name}  ${n}  ${sha.slice(0, 12)}  (already here, sealed)`); process.exit(0) }

const buf = Buffer.from([...out.matchAll(/^B:([A-Za-z0-9+/=]+)$/gm)].map(m => m[1]).join(''), 'base64')
const got = createHash('sha256').update(buf).digest('hex').toUpperCase()
if (buf.length !== n || got !== sha) throw new Error(`fetch-archive: ${pick.name} arrived as ${buf.length} bytes / ${got.slice(0, 12)}, the PC says ${n} / ${sha.slice(0, 12)}`)
const plainBytes = await gunzipLength(buf) // a torn or half-written archive fails its gzip CRC here, before anything is written
writeFileSync(target, sealBundle(buf, sealKey()))
writeFileSync(marker, sha)
console.log(`fetched   ${pick.name}  ${n}  ${sha.slice(0, 12)}  (${plainBytes} bytes unpacked)  written ${pick.mtime.toISOString()}  -> ${target}`)

// Keep the newest --keep sealed archives this tool wrote; never touch anything else in the folder.
const mine = readdirSync(dest).filter(f => /^\d{8}\.arz\.sealed$/.test(f)).sort().reverse()
for (const old of mine.slice(keep)) { unlinkSync(join(dest, old)); if (existsSync(join(dest, old + '.sha'))) unlinkSync(join(dest, old + '.sha')); console.log(`pruned    ${old}`) }
