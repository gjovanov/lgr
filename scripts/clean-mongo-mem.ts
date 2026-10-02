/**
 * Sweep `mongo-mem-*` data directories that a test run left behind.
 *
 * ⚠ **Why this is needed even though the leak is fixed.** `mongodb-memory-server` removes its data
 * directory inside `stop()`, not on process exit. The in-process fix (`releaseMongoRepos`,
 * `teardownTestDB`) covers a normal run — but an ABNORMAL exit skips `afterAll` entirely, and no
 * in-process change can cover that:
 *
 *   · a run killed from the terminal or the IDE;
 *   · a hook timeout cascade that reaps the shared mongod ("killed N dangling processes");
 *   · a crash in a test file's module scope, before any hook is registered.
 *
 * Each leftover is ~300 MB. 36 of them had accumulated — **10.9 GB** — before anybody noticed,
 * which is what a slow leak with no sweeper looks like.
 *
 *   bun scripts/clean-mongo-mem.ts            # what it WOULD delete
 *   bun scripts/clean-mongo-mem.ts --execute  # delete it
 *   bun scripts/clean-mongo-mem.ts --execute --older-than 1   # keep today's
 *
 * ⚠ Dry run by default, like every other script in this repo that deletes things.
 *
 * ⚠ It refuses to touch a directory whose `mongod.lock` is held by a LIVE process: that is a server
 * still running, and deleting its data directory underneath it turns a slow leak into a corrupted
 * test run that fails somewhere else entirely.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const olderThanIdx = args.indexOf('--older-than')
const olderThanDays = olderThanIdx === -1 ? 0 : Number(args[olderThanIdx + 1] ?? 0)

const tmp = os.tmpdir()
const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000

function dirSize(dir: string): number {
  let total = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    try {
      total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size
    } catch { /* vanished mid-walk; it is a temp directory */ }
  }
  return total
}

/**
 * Is a mongod still using this directory?
 *
 * ⚠ A non-empty `mongod.lock` is mongod's own "I am running" marker — it holds the pid. An empty
 * one is what a CLEAN shutdown leaves, so emptiness is the signal that this directory is garbage.
 * Checking the pid rather than merely the file's existence matters because a killed mongod leaves a
 * populated lock behind too, and that directory IS garbage.
 */
function inUse(dir: string): string | null {
  const lock = path.join(dir, 'mongod.lock')
  let pid = ''
  try {
    pid = fs.readFileSync(lock, 'utf8').trim()
  } catch {
    return null
  }
  if (!pid) return null
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(Number(pid), 0)
    return pid
  } catch {
    return null // the pid is stale: the process is gone
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

const candidates = fs
  .readdirSync(tmp, { withFileTypes: true })
  .filter(e => e.isDirectory() && /^mongo-mem-/.test(e.name))
  .map(e => path.join(tmp, e.name))

let reclaimable = 0
let skipped = 0
const doomed: string[] = []

for (const dir of candidates) {
  let stat: fs.Stats
  try {
    stat = fs.statSync(dir)
  } catch {
    continue
  }
  if (stat.mtimeMs > cutoff) {
    console.log(`skip  ${path.basename(dir)}  newer than --older-than ${olderThanDays}d`)
    skipped++
    continue
  }
  const pid = inUse(dir)
  if (pid) {
    console.log(`SKIP  ${path.basename(dir)}  mongod pid ${pid} is still running`)
    skipped++
    continue
  }
  const size = dirSize(dir)
  reclaimable += size
  doomed.push(dir)
  console.log(`${execute ? 'rm   ' : 'would'} ${path.basename(dir)}  ${mb(size)}  (${stat.mtime.toISOString().slice(0, 10)})`)
}

if (execute) {
  for (const dir of doomed) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      console.log(`failed ${path.basename(dir)}: ${e}`)
    }
  }
}

console.log(
  `\n${candidates.length} directories in ${tmp}; ` +
  `${doomed.length} ${execute ? 'removed' : 'removable'} (${mb(reclaimable)}), ${skipped} skipped`,
)
if (!execute && doomed.length) console.log('Dry run. Pass --execute to delete.')
