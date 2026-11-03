/**
 * FR-25 §7.4: the comma-separated records of the NRA's declaration files. Import-pure.
 *
 * Text is in double quotes and may hold neither a comma nor a quote, which is the spec's rule and
 * why this needs no escaping. Whether a field is quoted is part of the format: `"0000"` and `0` are
 * different fields, so a parsed field keeps it.
 */
export interface RawField {
  value: string
  quoted: boolean
}

export function splitRecord(line: string): RawField[] {
  const out: RawField[] = []
  let i = 0
  while (i <= line.length) {
    if (line[i] === '"') {
      const end = line.indexOf('"', i + 1)
      if (end < 0) throw new Error('a quoted field is not closed')
      out.push({ value: line.slice(i + 1, end), quoted: true })
      i = end + 1
      if (i < line.length && line[i] !== ',') throw new Error('text after a closing quote')
      i++
    } else {
      let end = line.indexOf(',', i)
      if (end < 0) end = line.length
      out.push({ value: line.slice(i, end), quoted: false })
      i = end + 1
    }
  }
  return out
}

/** A text field as the spec wants it, or a refusal: a comma or a quote would shift every later field. */
export function quoted(value: string): string {
  if (/[",\r\n]/.test(value)) throw new Error('a text field may hold no comma, quote or line break')
  return `"${value}"`
}

export const money = (value: number): string => value.toFixed(2)
