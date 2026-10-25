import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from 'config'
import { localTools, extractLocally, resetLocalTools } from 'services/biz/doc-import/local-extract'
import { ocrExtract } from 'services/biz/doc-import/ocr-client'
import { extractPdf } from '../../../ocr-server/src/extract.js'

/**
 * FR-20.88 (plan step P2-6c): a master reads its own PDFs with poppler and tesseract, and only the
 * model's steps go through lgrai.app. Run against the machine's real tools when it has them (the
 * Linux package depends on poppler-utils, tesseract-ocr and tesseract-ocr-bul); without them the
 * reader says so and the master relays, which `documents-relay.flow` covers.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

/** A one-page PDF with a text layer: what poppler reads without OCR. */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 10 Tf 72 720 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const TEXT = 'Invoice 2000012345 for the field test, net 100.00, VAT 20.00, total 120.00 EUR'
const saved = { role: config.node.role }

afterEach(() => {
  ;(config.node as any).role = saved.role
  resetLocalTools()
})

describe('a master reads its own PDFs (FR-20.88)', () => {
  it('finds the tools, or says there are none', async () => {
    const t = await localTools()
    // The release's Linux lane installs the package, which brings the tools: there, none is a failure.
    if (process.env.LGR_EXPECT_LOCAL_TOOLS) expect(t).not.toBeNull()
    if (t) {
      expect(t.tesseract.length).toBeGreaterThan(0)
    } else {
      // No tesseract with Bulgarian here (a developer's box): the master relays, and that is covered.
      expect(t).toBeNull()
    }
  })

  it('reads a text layer as the sidecar reads it', async () => {
    const t = await localTools()
    if (!t) return
    const pdf = tinyPdf(TEXT)
    const mine = await extractLocally(t, pdf)
    expect(mine).toMatchObject({ method: 'native', pages: 1 })
    expect(mine.text).toContain('Invoice 2000012345')
    // The sidecar's own code on the same bytes: one reading, wherever it runs.
    const dir = mkdtempSync(join(tmpdir(), 'lgr-sidecar-'))
    try {
      const file = join(dir, 'in.pdf')
      writeFileSync(file, pdf)
      expect(extractPdf(file)).toEqual(mine)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('on a master, extraction never leaves the machine when it has the tools', async () => {
    const t = await localTools()
    if (!t) return
    ;(config.node as any).role = 'master'
    // No node token, no org: a relay could not even be asked. Local reading needs neither.
    const r = await ocrExtract(tinyPdf(TEXT), 'local.pdf')
    expect(r.method).toBe('native')
    expect(r.text).toContain('total 120.00 EUR')
  })

  it('a scan goes to tesseract, in Bulgarian', async () => {
    const t = await localTools()
    if (!t) return
    // forceOcr: the rasterised page is read by tesseract, the way a scanned invoice is.
    const r = await extractLocally(t, tinyPdf(TEXT), { forceOcr: true })
    expect(r).toMatchObject({ method: 'tesseract', pages: 1 })
    expect(r.text.replace(/\s+/g, ' ')).toMatch(/2000012345/)
  })

  it('no tools: the reader answers null, so the master relays', async () => {
    resetLocalTools(null)
    expect(await localTools()).toBeNull()
  })
})
