import { describe, it, expect } from 'bun:test'
import { join, resolve } from 'node:path'
import { restoreTarget, splitLines } from 'services/biz/backup/backup-files.service'

/**
 * FR-20.21 (plan step P1-9) — how a files sidecar is read back: its lines, and the paths a restore
 * accepts. On a master the sidecar is the only copy of the uploads.
 */

async function lines(chunks: Buffer[]): Promise<string[]> {
  async function* source() {
    for (const c of chunks) yield c
  }
  const out: string[] = []
  for await (const l of splitLines(source())) out.push(l)
  return out
}

describe('a sidecar read back line by line', () => {
  const text = '{"format":"lgr-backup-files-2"}\n{"path":"docs/2026-09-03/фактура-1.pdf"}\n{"path":"files/Лого №2.png"}\n'

  it('keeps a character that a chunk boundary splits', async () => {
    // Every byte its own chunk, so each Cyrillic letter (two bytes) is split once.
    const bytewise = [...Buffer.from(text)].map(b => Buffer.from([b]))
    expect(await lines(bytewise)).toEqual(text.trim().split('\n'))
  })

  it('reads a last line with no newline, and skips empty ones', async () => {
    expect(await lines([Buffer.from('a\n\nb')])).toEqual(['a', 'b'])
  })

  it('joins a line carried across many chunks', async () => {
    const long = 'x'.repeat(100_000)
    const buf = Buffer.from(`${long}\nend\n`)
    const chunks: Buffer[] = []
    for (let i = 0; i < buf.length; i += 4096) chunks.push(buf.subarray(i, i + 4096))
    expect(await lines(chunks)).toEqual([long, 'end'])
  })
})

describe('the paths a restore accepts', () => {
  const root = resolve('lgr-uploads', '6a00')

  it('a plain path lands under the root', () => {
    expect(restoreTarget(root, 'docs/2026-09-03/фактура-1.pdf', true))
      .toBe(join(root, 'docs', '2026-09-03', 'фактура-1.pdf'))
  })

  const refused = [
    '../escaped.txt', '/etc/passwd', 'docs/../../x', '', 'docs//x', 'docs/./x',
    // The backups, however they are spelled.
    'backups/x', './backups/x', 'docs/../backups/x',
  ]
  for (const p of refused) {
    it(`refuses ${JSON.stringify(p)}`, () => {
      expect(restoreTarget(root, p, true)).toBeNull()
    })
  }

  it(`a docs-rooted sidecar may hold a folder called backups: it is not the org's`, () => {
    expect(restoreTarget(root, 'backups/x', false)).toBe(join(root, 'backups', 'x'))
  })

  if (process.platform === 'win32') {
    // Windows folds case, strips a trailing dot or space, and reads `\` and `:` its own way.
    for (const p of ['Backups/x', 'backups./x', 'backups /x', 'docs\\..\\..\\x', 'docs/a.pdf:stream']) {
      it(`on Windows, refuses ${JSON.stringify(p)}`, () => {
        expect(restoreTarget(root, p, true)).toBeNull()
      })
    }
  }
})
