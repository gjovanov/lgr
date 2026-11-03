import { describe, it, expect, afterAll } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `scripts/compare-vat-files.ts`, FR-25 R2's gate, as it runs: a folder in, `equal` or a count out, and
 * an exit code. On the made-up golden files; the filed months are private and meet it by hand.
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..')
const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'vat-files')
const tmp = mkdtempSync(join(tmpdir(), 'lgr-vat-gate-'))

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

async function gate(dir: string) {
  const proc = Bun.spawn(['bun', 'run', 'scripts/compare-vat-files.ts', '--dir', dir], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: out + err }
}

describe('the gate', () => {
  it('passes the golden months, each one by name', async () => {
    const { code, out } = await gate(FIXTURES)
    expect(code).toBe(0)
    expect(out).toContain('202605  equal')
    expect(out).toContain('202606  equal')
    expect(out).toContain('2 months: 2 equal, 0 differ. 7 files (1 VIES), 22 records.')
  })

  it('fails on one changed amount, with a count, and prints no value', async () => {
    const dir = join(tmp, 'changed')
    cpSync(FIXTURES, dir, { recursive: true })
    const file = join(dir, '202605', '999999999', 'PRODAGBI.txt')
    const bytes = readFileSync(file)
    bytes[227 - 3] = 0x35 // 02-21 of the first row: 20.00 becomes 50.00
    writeFileSync(file, bytes)

    const { code, out } = await gate(dir)
    expect(code).toBe(1)
    expect(out).toContain('202605  DEKLAR.txt: 1 of 1 records differ, PRODAGBI.txt: 1 of 9 records differ')
    expect(out).toContain('202606  equal')
    expect(out).toContain('2 months: 1 equal, 1 differ.')
    expect(out).not.toContain('ТЕСТОВ')
    expect(out).not.toContain('50.00')
    expect(out).not.toContain('BG999999999')
  })

  it('says a file it cannot read is unreadable, naming no value', async () => {
    const dir = join(tmp, 'broken')
    cpSync(FIXTURES, dir, { recursive: true })
    const file = join(dir, '202606', '999999999', 'DEKLAR.txt')
    writeFileSync(file, readFileSync(file).subarray(0, 100))

    const { code, out } = await gate(dir)
    expect(code).toBe(1)
    expect(out).toContain('202606  unreadable: The file does not end its last record with CRLF')
  })

  it('wants a folder with months in it', async () => {
    expect((await gate(join(tmp))).code).toBe(2)
  })
})
