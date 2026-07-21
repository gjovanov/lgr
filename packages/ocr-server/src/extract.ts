/**
 * Text extraction from an invoice PDF.
 * Tesseract-bg is the OCR engine; the embedded PDF text layer (poppler pdftotext)
 * is used as a higher-fidelity fast-path when present (digital invoices), else
 * pages are rasterized (pdftoppm) and OCR'd with `tesseract -l bul`.
 * Requires system binaries: poppler-utils (pdftotext, pdftoppm, pdfinfo) + tesseract-ocr(-bul).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtractResult } from './schema.js'

const BIG = 1 << 28

export function pageCount(pdfPath: string): number {
  try {
    const out = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf-8' })
    const m = out.match(/Pages:\s+(\d+)/)
    return m ? Number(m[1]) : 1
  } catch {
    return 1
  }
}

export function nativeText(pdfPath: string): string {
  try {
    return execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf-8', maxBuffer: BIG })
  } catch {
    return ''
  }
}

export function tesseractText(pdfPath: string, lang = 'bul', dpi = 300): string {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-'))
  try {
    execFileSync('pdftoppm', ['-r', String(dpi), '-png', pdfPath, join(dir, 'page')], { maxBuffer: BIG })
    const pngs = readdirSync(dir).filter(f => f.endsWith('.png')).sort()
    return pngs
      .map(png => {
        try {
          return execFileSync('tesseract', [join(dir, png), 'stdout', '-l', lang, '--psm', '6'], { encoding: 'utf-8', maxBuffer: BIG })
        } catch {
          return ''
        }
      })
      .join('\n\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A text layer is "meaningful" if it has real content (not an empty/vector-only page). */
function hasTextLayer(text: string): boolean {
  return text.replace(/\s+/g, '').length >= 40
}

export function extractPdf(pdfPath: string, opts?: { forceOcr?: boolean; lang?: string }): ExtractResult {
  const pages = pageCount(pdfPath)
  if (!opts?.forceOcr) {
    const native = nativeText(pdfPath)
    if (hasTextLayer(native)) return { text: native.trim(), method: 'native', pages }
  }
  return { text: tesseractText(pdfPath, opts?.lang ?? 'bul').trim(), method: 'tesseract', pages }
}
