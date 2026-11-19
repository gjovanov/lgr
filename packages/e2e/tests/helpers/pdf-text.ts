import { inflateSync, constants } from 'node:zlib'

/**
 * The text of a PDF the server printed (Chromium, through md-to-pdf), enough to ask whether a word is on it.
 *
 * Chromium writes text as glyph ids, two bytes each, inside deflated content streams, and a font's ToUnicode map says
 * what each id is. Which font a run uses would take the page's resources to follow; instead every run of the file is
 * read through every font's map, one text per font. A word set in one font reads right through that font's map, and
 * the other texts are noise. Spaces are left out of both sides of the comparison: a run can be positioned word by word.
 *
 * Not a PDF parser: it holds for what Chromium writes, and a spec that needs more should not grow this into one.
 */
export function pdfTexts(bytes: Buffer): string[] {
  const streams = streamsOf(bytes)
  const maps = streams.filter(s => s.includes('begincmap')).map(cmapOf)
  const runs = streams.filter(s => /\bT[Jj]\b/.test(s)).flatMap(s => [...s.matchAll(/<([0-9A-Fa-f\s]+)>/g)].map(m => m[1].replace(/\s+/g, '')))
  return maps.map(map => runs.map(hex => decode(hex, map)).join(''))
}

/** Whether `text` is printed on the PDF, spaces aside. */
export function pdfHasText(bytes: Buffer, text: string): boolean {
  const wanted = text.replace(/\s+/g, '')
  return pdfTexts(bytes).some(t => t.replace(/\s+/g, '').includes(wanted))
}

/** Every stream of the file that inflates, as latin1 text. */
function streamsOf(bytes: Buffer): string[] {
  const out: string[] = []
  const raw = bytes.toString('latin1')
  // ⚠ Not the `stream` of an `endstream`: read from there, every other stream would start inside the previous one.
  const start = /(?<!end)stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = start.exec(raw))) {
    const from = m.index + m[0].length
    const to = raw.indexOf('endstream', from)
    if (to < 0) break
    try {
      out.push(inflateSync(bytes.subarray(from, to), { finishFlush: constants.Z_SYNC_FLUSH }).toString('latin1'))
    } catch {
      // Not deflated, or not a stream we can read (an image, a font program): nothing to read.
    }
    start.lastIndex = to + 'endstream'.length
  }
  return out
}

const utf16 = (hex: string) => {
  let s = ''
  for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  return s
}

/** A ToUnicode map: glyph id (hex, upper case) → text. */
function cmapOf(cmap: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(src.toUpperCase(), utf16(dst))
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, rest] of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const first = parseInt(lo, 16)
      const last = parseInt(hi, 16)
      const listed = rest.startsWith('[') ? [...rest.matchAll(/<([0-9A-Fa-f]+)>/g)].map(x => x[1]) : null
      for (let code = first; code <= last; code++) {
        const key = code.toString(16).toUpperCase().padStart(lo.length, '0')
        if (listed) map.set(key, utf16(listed[code - first] ?? ''))
        else {
          const base = parseInt(rest.slice(1, -1), 16) + (code - first)
          map.set(key, String.fromCharCode(base))
        }
      }
    }
  }
  return map
}

function decode(hex: string, map: Map<string, string>): string {
  let s = ''
  for (let i = 0; i + 4 <= hex.length; i += 4) s += map.get(hex.slice(i, i + 4).toUpperCase()) ?? ''
  return s
}
