import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ⚠ `rmSync('', { recursive: true, force: true })` deletes what is in the working directory.
 *
 * A suite that makes its scratch directory in `beforeAll` and deletes it in `afterAll` holds `''` until then. When
 * `setupTestDB` throws first, `afterAll` runs all the same. Stopping a test run does that (the next mongod does not
 * start), and on 2026-11-02 it emptied a worktree, twice, `.git` included. In the shared checkout it would take the
 * gitignored `.secrets` and `_docs` with it, which nothing can bring back.
 *
 * So a path that starts empty is asked about before it is deleted.
 */
const ROOT = join(import.meta.dir, '..')
const testFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? testFiles(path) : path.endsWith('.test.ts') ? [path] : []
})

describe('a test teardown', () => {
  it('never deletes a path that may still be empty', () => {
    const unguarded: string[] = []
    for (const file of testFiles(ROOT)) {
      const source = readFileSync(file, 'utf8')
      for (const [, name] of source.matchAll(/^\s*let ([A-Za-z_]+)(?:: string)? = ''\s*$/gm)) {
        const deleted = new RegExp(`(?<!if \\(${name}\\) )rmSync\\(${name}[,)]`)
        if (deleted.test(source)) unguarded.push(`${file.slice(ROOT.length + 1)}: ${name}`)
      }
    }
    expect(unguarded).toEqual([])
  })
})
