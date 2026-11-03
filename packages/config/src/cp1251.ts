/**
 * Windows-1251 codec — the code page every Bulgarian fiscal device speaks.
 *
 * Import-pure (no Node APIs) so tests and any future browser-side use can share it.
 *
 * Complete table, not just А-я: the ISL protocol family (Eltrade, Daisy, Datecs) also accepts
 * the 0x80–0xBF block, which carries №, €, «», typographic dashes and the Serbian/Macedonian
 * letters the `mk` locale produces. Anything the code page cannot represent degrades to its
 * unaccented base letter when there is one (é → e) and to `?` otherwise — never to a
 * multi-byte UTF-8 sequence, which a device would read as two garbage characters.
 *
 * Note: `tremol.ts` still carries its own reduced copy (А-я, Ёё, №). It is left alone on
 * purpose — that driver is field-proven and a codec swap is not part of the Eltrade work.
 */

/** Unicode code points for bytes 0x80–0xBF. 0x98 is unassigned in cp1251. */
const HIGH_BLOCK: readonly number[] = [
  0x0402, 0x0403, 0x201A, 0x0453, 0x201E, 0x2026, 0x2020, 0x2021, 0x20AC, 0x2030, 0x0409, 0x2039, 0x040A, 0x040C, 0x040B, 0x040F,
  0x0452, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0xFFFD, 0x2122, 0x0459, 0x203A, 0x045A, 0x045C, 0x045B, 0x045F,
  0x00A0, 0x040E, 0x045E, 0x0408, 0x00A4, 0x0490, 0x00A6, 0x00A7, 0x0401, 0x00A9, 0x0404, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x0407,
  0x00B0, 0x00B1, 0x0406, 0x0456, 0x0491, 0x00B5, 0x00B6, 0x00B7, 0x0451, 0x2116, 0x0454, 0x00BB, 0x0458, 0x0405, 0x0455, 0x0457,
]

const ENCODE = new Map<number, number>()
for (let i = 0; i < HIGH_BLOCK.length; i++) {
  if (HIGH_BLOCK[i] !== 0xFFFD) ENCODE.set(HIGH_BLOCK[i], 0x80 + i)
}
for (let cp = 0x0410; cp <= 0x044F; cp++) ENCODE.set(cp, cp - 0x0410 + 0xC0)

const QUESTION_MARK = 0x3F

function encodeCodePoint(cp: number): number {
  if (cp < 0x80) return cp
  const mapped = ENCODE.get(cp)
  if (mapped !== undefined) return mapped
  // Latin letters with diacritics: keep the base letter rather than a bare '?'.
  const base = String.fromCodePoint(cp).normalize('NFD').codePointAt(0)
  if (base !== undefined && base < 0x80) return base
  return QUESTION_MARK
}

/** Encode a JS string as Windows-1251 bytes. */
export function encodeCp1251(text: string): Uint8Array {
  const out: number[] = []
  for (const ch of text) out.push(encodeCodePoint(ch.codePointAt(0)!))
  return Uint8Array.from(out)
}

/** Decode Windows-1251 bytes into a JS string. */
export function decodeCp1251(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) {
    if (b < 0x80) s += String.fromCharCode(b)
    else if (b >= 0xC0) s += String.fromCharCode(0x0410 + (b - 0xC0))
    else s += String.fromCharCode(HIGH_BLOCK[b - 0x80])
  }
  return s
}
