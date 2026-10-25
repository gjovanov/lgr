/**
 * FR-20.88 (plan step P2-6c): a master reads its own PDFs. Extracting text is poppler and
 * tesseract, nothing that needs a model, so a master runs it itself and only the steps that do
 * (the draft, the line matching) go through lgrai.app (`ocr-client.ts`). With the tools missing
 * (a Windows package before it carries them), extraction still goes through lgrai.app, as P2-6b
 * made it.
 *
 * ⚠ The same algorithm as the sidecar's (`packages/ocr-server/src/extract.ts`), on purpose: the
 * native text layer when it holds at least 40 non-space characters, otherwise every page
 * rasterised at 300 dpi and read by `tesseract -l bul --psm 6`. A master and lgrai.app reading the
 * same PDF differently would import it differently. The cross-check test runs both.
 *
 * Where the tools are: `LGR_PDF_TOOLS_DIR` (the supervisor names the package's own `tools/`), else
 * `PATH` (a Linux master: the .deb depends on poppler-utils, tesseract-ocr and tesseract-ocr-bul).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtractResult } from './ocr-client.js'

const BIG = 1 << 28
/** A long scan rasterised at 300 dpi and read page by page takes a while; never forever. */
const TOOL_TIMEOUT_MS = Number(process.env.LOCAL_EXTRACT_TIMEOUT_MS) || 180_000

export interface LocalTools {
  pdftotext: string
  pdftoppm: string
  pdfinfo: string
  tesseract: string
}

function run(file: string, args: string[], timeout = TOOL_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf-8', maxBuffer: BIG, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve(stdout)
    })
  })
}

function tool(dir: string | undefined, name: string): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  if (dir) {
    for (const candidate of [join(dir, exe), join(dir, 'bin', exe)]) if (existsSync(candidate)) return candidate
  }
  return exe
}

let cached: { at: number; tools: LocalTools | null } | null = null
const CACHE_MS = 10 * 60_000

/**
 * The tools, if all four answer and tesseract knows Bulgarian; `null` otherwise. Asked once and kept
 * ten minutes, so a package installed later is found without a restart.
 */
export async function localTools(): Promise<LocalTools | null> {
  if (cached && (cached.at === Number.POSITIVE_INFINITY - 1 || Date.now() - cached.at < CACHE_MS)) return cached.tools
  const dir = (process.env.LGR_PDF_TOOLS_DIR || '').trim() || undefined
  const tools: LocalTools = { pdftotext: tool(dir, 'pdftotext'), pdftoppm: tool(dir, 'pdftoppm'), pdfinfo: tool(dir, 'pdfinfo'), tesseract: tool(dir, 'tesseract') }
  let found: LocalTools | null = null
  try {
    // poppler prints its version on stderr and may exit non-zero for -v: answering at all is enough.
    for (const t of [tools.pdftotext, tools.pdftoppm, tools.pdfinfo]) {
      await run(t, ['-v'], 10_000).catch((e: any) => {
        if (e?.code === 'ENOENT') throw e
      })
    }
    const langs = await run(tools.tesseract, ['--list-langs'], 10_000)
    if (/^bul$/m.test(langs)) found = tools
  } catch {
    found = null
  }
  cached = { at: Date.now(), tools: found }
  return found
}

/** Tests only: forget what was found, or pin an answer (`null`: no tools here) until the next reset. */
export function resetLocalTools(pin?: LocalTools | null): void {
  cached = pin === undefined ? null : { at: Number.POSITIVE_INFINITY - 1, tools: pin }
}

async function pageCount(t: LocalTools, pdf: string): Promise<number> {
  try {
    const m = (await run(t.pdfinfo, [pdf], 30_000)).match(/Pages:\s+(\d+)/)
    return m ? Number(m[1]) : 1
  } catch {
    return 1
  }
}

async function nativeText(t: LocalTools, pdf: string): Promise<string> {
  try {
    return await run(t.pdftotext, ['-layout', '-enc', 'UTF-8', pdf, '-'])
  } catch {
    return ''
  }
}

async function tesseractText(t: LocalTools, pdf: string, dir: string, lang = 'bul', dpi = 300): Promise<string> {
  await run(t.pdftoppm, ['-r', String(dpi), '-png', pdf, join(dir, 'page')])
  const pngs = readdirSync(dir).filter(f => f.endsWith('.png')).sort()
  const pages: string[] = []
  // One page at a time: tesseract is already multi-threaded, and a master is also a till's server.
  for (const png of pngs) pages.push(await run(t.tesseract, [join(dir, png), 'stdout', '-l', lang, '--psm', '6']).catch(() => ''))
  return pages.join('\n\n')
}

/** A text layer is meaningful with real content: not empty, not a vector-only page. */
function hasTextLayer(text: string): boolean {
  return text.replace(/\s+/g, '').length >= 40
}

/** PDF bytes → text, on this machine. */
export async function extractLocally(t: LocalTools, pdf: Buffer, opts: { forceOcr?: boolean; lang?: string } = {}): Promise<ExtractResult> {
  const dir = mkdtempSync(join(tmpdir(), 'lgr-extract-'))
  try {
    const file = join(dir, 'in.pdf')
    writeFileSync(file, pdf)
    const pages = await pageCount(t, file)
    if (!opts.forceOcr) {
      const native = await nativeText(t, file)
      if (hasTextLayer(native)) return { text: native.trim(), method: 'native', pages }
    }
    const raster = join(dir, 'pages')
    mkdirSync(raster)
    return { text: (await tesseractText(t, file, raster, opts.lang ?? 'bul')).trim(), method: 'tesseract', pages }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
