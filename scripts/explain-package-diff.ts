/**
 * Which files of two server packages differ, and where: CI's reproducibility check (P0b-9) calls this
 * when the two manifests disagree.
 *
 *   bun scripts/explain-package-diff.ts dist/lgr-server dist/lgr-server-again
 *
 * The check failed once (2026-10-25, on `app/server.js`) and never since, and `cmp` on the manifests
 * says only "line 64". A flake that does not say what changed cannot be chased, so this prints
 * every differing header field and file, with the bytes around the first difference of each.
 *
 * Read-only.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST } from './lib/server-package.ts'

const [a, b] = process.argv.slice(2)
if (!a || !b) {
  console.error('usage: bun scripts/explain-package-diff.ts <package> <package>')
  process.exit(2)
}

const read = (dir: string) => JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
const ma = read(a)
const mb = read(b)

for (const key of Object.keys({ ...ma, ...mb })) {
  if (key === 'files') continue
  if (JSON.stringify(ma[key]) !== JSON.stringify(mb[key])) console.log(`${key}: ${JSON.stringify(ma[key])} → ${JSON.stringify(mb[key])}`)
}

type Entry = { path: string; size: number; sha256: string }
const filesA = new Map<string, Entry>(ma.files.map((f: Entry) => [f.path, f]))
const filesB = new Map<string, Entry>(mb.files.map((f: Entry) => [f.path, f]))
const around = (bytes: Buffer, at: number) => JSON.stringify(bytes.subarray(Math.max(0, at - 240), at + 240).toString('utf8'))

let differing = 0
for (const [path, x] of filesA) {
  const y = filesB.get(path)
  if (!y) { console.log(`only in ${a}: ${path}`); differing++; continue }
  if (x.sha256 === y.sha256) continue
  differing++
  console.log(`${path}: ${x.size} → ${y.size} bytes`)
  if (!existsSync(join(a, path)) || !existsSync(join(b, path))) continue
  const bytesA = readFileSync(join(a, path))
  const bytesB = readFileSync(join(b, path))
  let at = 0
  while (at < bytesA.length && at < bytesB.length && bytesA[at] === bytesB[at]) at++
  console.log(`  first difference at byte ${at}`)
  console.log(`  ${a}: ${around(bytesA, at)}`)
  console.log(`  ${b}: ${around(bytesB, at)}`)
}
for (const path of filesB.keys()) {
  if (!filesA.has(path)) { console.log(`only in ${b}: ${path}`); differing++ }
}
console.log(differing ? `${differing} file(s) differ` : 'the files are identical; only the header differs')
