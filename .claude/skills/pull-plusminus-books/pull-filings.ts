#!/usr/bin/env bun
// pull-filings.ts — the files the accountant's PlusMinus writes BESIDE its database: what was filed with the NRA and the payroll
// module's own settings. The archive holds none of them, and the importers read them as files:
//
//   nap\vat\<yyyymm>\<eik>\{DEKLAR,POKUPKI,PRODAGBI,VIES}.txt      → <plain>/nap/vat/…          (scripts/import-vat-files.ts --dir)
//   nap\{decl1,decl6,decl_1_6,ETZ,UvedTD,SPR73_6}\…, docs\payroll*.json, exports\payroll*
//                                                                  → <sealed>/…  lgr-sealed-1    (scripts/import-payroll.ts --root)
//
//   bun pull-filings.ts [--plain DIR] [--sealed DIR] [--list]
//     defaults: $ACC_FILINGS_DIR and $ACC_FILINGS_SEALED_DIR (.secrets/plusminus-stores.env), else $ACC_DOCS_ROOT/filings{,-sealed}
//
// Read-only on the PC (listing, and reads with FileShare.ReadWrite), and only ever inside the Regal install root: the PC keeps other
// companies' installs, which are never listed. A file already here unchanged (same SHA-256) is not fetched again.
// ⚠ Payroll files are sealed in memory as they arrive; only the sealed form is written. Prints counts per folder, never a name.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { need, optional } from '../pull-plusminus-api/stores-env'
import { sealBundle } from '../../../packages/services/src/biz/backup/backup-crypto'
import { sealKey } from './seal-key'

const args = process.argv.slice(2)
const opt = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d }
const agent = need('ACC_ROOMLER_AGENT'), pmRoot = need('ACC_PM_ROOT')
const plainRoot = opt('--plain', optional('ACC_FILINGS_DIR') ?? join(need('ACC_DOCS_ROOT'), 'filings'))
const sealedRoot = opt('--sealed', optional('ACC_FILINGS_SEALED_DIR') ?? join(need('ACC_DOCS_ROOT'), 'filings-sealed'))
const BATCH = 24 * 1024 * 1024 // raw bytes per ssh call: one call carried 50 MB on 2026-11-05

const SELECT = `$files = @()
$vat = Join-Path $root 'nap\\vat'
if (Test-Path -LiteralPath $vat) { $files += Get-ChildItem -LiteralPath $vat -Recurse -File -Force | ForEach-Object { [pscustomobject]@{ F = $_; K = 'plain' } } }
foreach ($d in 'nap\\decl1','nap\\decl6','nap\\decl_1_6','nap\\ETZ','nap\\UvedTD','nap\\SPR73_6') {
  $p = Join-Path $root $d
  if (Test-Path -LiteralPath $p) { $files += Get-ChildItem -LiteralPath $p -Recurse -File -Force | Where-Object { $_.Name -notmatch '^(DEKLAR|POKUPKI|PRODAGBI)' } | ForEach-Object { [pscustomobject]@{ F = $_; K = 'sealed' } } }
}
$files += Get-ChildItem -LiteralPath (Join-Path $root 'exports') -File -Force | Where-Object { $_.Name -match '^payroll' } | ForEach-Object { [pscustomobject]@{ F = $_; K = 'sealed' } }
$files += Get-ChildItem -LiteralPath (Join-Path $root 'docs') -File -Force | Where-Object { $_.Name -match '^payroll.*\\.json$' } | ForEach-Object { [pscustomobject]@{ F = $_; K = 'sealed' } }
$files = @($files | Sort-Object { $_.F.FullName })
`
function ps(body: string, timeoutMs: number): string {
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\n$root='${pmRoot.replaceAll("'", "''")}'\n${SELECT}\n${body}`
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  for (let t = 1; t <= 5; t++) {
    const r = spawnSync('roomler', ['ssh', agent, '--', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
      { encoding: 'latin1', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = (r.stdout ?? '').replace(/\r/g, '')
    if (/too many ssh requests|rate.?limit/i.test(out + (r.stderr ?? ''))) { Bun.sleepSync(t * 15000); continue }
    if (out.includes('\nEND')) return out
    console.error(`pull-filings: roomler ssh attempt ${t} gave no END (exit ${r.status}); retrying`)
    Bun.sleepSync(t * 5000)
  }
  throw new Error('roomler ssh kept failing; is the books PC online?')
}

const listing = ps(`$sha = [Security.Cryptography.SHA256]::Create(); $i = 0
foreach ($x in $files) {
  $s = [IO.File]::Open($x.F.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); $h = [BitConverter]::ToString($sha.ComputeHash($s)).Replace('-',''); $l = $s.Length; $s.Close()
  'F ' + $i + ' ' + $x.K + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($x.F.FullName.Substring($root.Length).TrimStart('\\'))) + ' ' + $l + ' ' + $h
  $i++
}
'END'`, 300000)
const files = [...listing.matchAll(/^F (\d+) (plain|sealed) (\S+) (\d+) ([0-9A-F]{64})$/gm)].map(m => ({
  idx: Number(m[1]), kind: m[2] as 'plain' | 'sealed', rel: Buffer.from(m[3], 'base64').toString('utf8').replaceAll('\\', '/'), size: Number(m[4]), sha: m[5],
}))
const localOf = (f: (typeof files)[number]) => join(f.kind === 'plain' ? plainRoot : sealedRoot, f.rel + (f.kind === 'sealed' ? '.sealed' : ''))
const have = (f: (typeof files)[number]) => {
  const path = localOf(f)
  if (f.kind === 'sealed') return existsSync(path + '.sha') && readFileSync(path + '.sha', 'utf8').trim() === f.sha
  return existsSync(path) && createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase() === f.sha
}
const todo = files.filter(f => !have(f))
const folder = (rel: string) => rel.split('/').slice(0, rel.startsWith('nap/') ? 2 : 1).join('/')
if (args.includes('--list')) {
  const per = new Map<string, [number, number]>()
  for (const f of files) { const k = `${folder(f.rel)} (${f.kind})`; const v = per.get(k) ?? [0, 0]; v[0]++; if (!have(f)) v[1]++; per.set(k, v) }
  for (const [k, [n, missing]] of [...per.entries()].sort()) console.log(`${k.padEnd(34)} ${String(n).padStart(5)} on the PC, ${missing} not here`)
  process.exit(0)
}

let written = 0, bad = 0, bytes = 0
const perFolder = new Map<string, number>()
for (let i = 0; i < todo.length;) {
  const batch: typeof todo = []
  let room = BATCH
  while (i < todo.length && (batch.length === 0 || todo[i].size <= room)) { batch.push(todo[i]); room -= todo[i].size; i++ }
  const out = ps(`foreach ($n in '${batch.map(f => f.idx).join(',')}'.Split(',')) {
  $p = $files[[int]$n].F.FullName; $b = [IO.File]::ReadAllBytes($p); $s = [Convert]::ToBase64String($b)
  if ($s.Length -eq 0) { 'S ' + $n + ' ' }
  for ($k = 0; $k -lt $s.Length; $k += 1048576) { 'S ' + $n + ' ' + $s.Substring($k, [Math]::Min(1048576, $s.Length - $k)) }
}
'END'`, 900000)
  const parts = new Map<number, string[]>()
  for (const m of out.matchAll(/^S (\d+) ?([A-Za-z0-9+/=]*)$/gm)) (parts.get(Number(m[1])) ?? parts.set(Number(m[1]), []).get(Number(m[1]))!).push(m[2])
  for (const f of batch) {
    const buf = Buffer.from((parts.get(f.idx) ?? []).join(''), 'base64')
    if (buf.length !== f.size || createHash('sha256').update(buf).digest('hex').toUpperCase() !== f.sha) { bad++; continue }
    const path = localOf(f)
    mkdirSync(dirname(path), { recursive: true })
    if (f.kind === 'sealed') { writeFileSync(path, sealBundle(buf, sealKey())); writeFileSync(path + '.sha', f.sha) }
    else writeFileSync(path, buf)
    written++; bytes += buf.length
    perFolder.set(`${folder(f.rel)} (${f.kind})`, (perFolder.get(`${folder(f.rel)} (${f.kind})`) ?? 0) + 1)
  }
}
console.log(`${files.length} files on the PC; fetched ${written} (${bytes} bytes), unchanged ${files.length - todo.length}, failed the checksum ${bad}`)
for (const [k, n] of [...perFolder.entries()].sort()) console.log(`  ${k}: ${n}`)
if (bad) process.exit(1)
