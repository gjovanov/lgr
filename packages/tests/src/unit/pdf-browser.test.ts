import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORMS, readLock, treeDigest } from '../../../../scripts/fetch-pdf-browser.ts'

const REPORTING = join(import.meta.dir, '..', '..', '..', 'reporting')

/** A Chrome-shaped tree: an executable and a nested resource. */
function tree(root: string, locale = 'Фактура', at = join('resources', 'locales')) {
  mkdirSync(join(root, at), { recursive: true })
  writeFileSync(join(root, 'chrome-headless-shell'), 'binary')
  writeFileSync(join(root, at, 'bg.pak'), locale)
  return root
}

describe('the Chrome a master prints with (FR-20.25)', () => {
  it('is the build puppeteer pins: a bump without `--update-lock` fails here, not on a master', async () => {
    const from = dirname(Bun.resolveSync('puppeteer/package.json', REPORTING))
    const { PUPPETEER_REVISIONS } = await import(Bun.resolveSync('puppeteer-core/internal/revisions.js', from))
    expect(readLock().buildId).toBe(PUPPETEER_REVISIONS['chrome-headless-shell'])
  })

  it('pins every platform Chrome for Testing publishes, each by a sha256 of its tree', () => {
    const lock = readLock()
    expect(lock.browser).toBe('chrome-headless-shell')
    expect(Object.keys(lock.tree).sort()).toEqual([...PLATFORMS].sort())
    for (const p of PLATFORMS) expect(lock.tree[p]).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('digests a tree by its paths and contents, wherever it was unpacked', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lgr-pdf-browser-'))
    try {
      const a = await treeDigest(tree(join(base, 'a')))
      expect(await treeDigest(tree(join(base, 'somewhere', 'else')))).toEqual(a)
      expect(a.files).toBe(2)
      // One letter changed (a Latin `a` for the Cyrillic one) is another tree.
      expect((await treeDigest(tree(join(base, 'b'), 'Фактурa'))).digest).not.toBe(a.digest)
      // So is the same file in another folder.
      expect((await treeDigest(tree(join(base, 'c'), 'Фактура', 'resources'))).digest).not.toBe(a.digest)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
