// doc.ts — read-only looks at pulled PlusMinus documents, and the one edit a booking run may need.
//
//   bun doc.ts lines <file.json> [<file.json> ...]
//       header and every line: quantity, item, store, prices, stock operations
//   bun doc.ts find <day api dir> "<part of an item name>"
//       every document of the day that moves that article (which document undoes which)
//   bun doc.ts rename <file.json> <out dir> "<item name in the file>=<name of the LGR product>" [more pairs ...]
//       a CORRECTED COPY of one document: the named lines get the LGR product's name (in `item` and `name`), nothing
//       else changes. For a line the importer cannot match because LGR's product is named differently. Writes the
//       copy and a README beside it that says what changed and why; book the copy with `daily.ts book --dir <out dir>
//       --only <number>`, in the document's own place in the order. Names are given without the group prefix.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const [mode, ...rest] = process.argv.slice(2)
const squash = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
const GROUP = /^([^:]+):/
const bare = (item: unknown) => String(item ?? '').replace(GROUP, '')
const isPrice = (k: string) => k === 'price' || k === 'retailPrice' || k === 'wholesalePrice' || /^price\d+$/.test(k)

function lines(files: string[]) {
  for (const f of files) {
    const d = JSON.parse(readFileSync(f, 'utf8'))
    const h = d.header ?? {}
    console.log(`== ${basename(f)} | ${h.doc ?? '?'} ${h.docNumber ?? '?'} date ${h.docDate ?? '?'} | partner ${String(h.partner ?? '(none)').replace(GROUP, '')} | sum ${h.sum ?? '-'} | created ${h.createdOn ?? '-'}${h.modifiedOn ? ` modified ${h.modifiedOn}` : ''}`)
    for (const l of d.lines ?? []) {
      const prices = Object.entries(l).filter(([k]) => isPrice(k)).map(([k, v]) => `${k}=${v}`).join(' ')
      const ops = (l.operations ?? []).map((o: any) => `${o.type}:${o.store}:${o.quantity}`).join(',')
      console.log(`   qty ${String(l.quantity ?? '-').padStart(8)} ${String(l.measure ?? '').padEnd(3)} | ${l.item ?? l.name} | store ${l.store ?? '-'} | ${prices || 'no prices'} | sum ${l.sum ?? '-'} | ops ${ops || '-'}${l.fromDocument ? ` | from ${l.fromDocument}` : ''}`)
    }
  }
}

function find(dir: string, needle: string) {
  const want = squash(needle)
  let hits = 0
  for (const f of readdirSync(dir).filter(n => n.endsWith('.json') && !n.startsWith('storeAvailability_')).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    for (const d of Array.isArray(parsed) ? parsed : [parsed]) for (const l of d?.lines ?? []) {
      if (!squash(l.item).includes(want) && !squash(l.name).includes(want)) continue
      hits++
      console.log(`${f}${Array.isArray(parsed) ? ` #${d?.header?.docNumber ?? '?'}` : ''} | qty ${l.quantity} | ${l.item ?? l.name} | store ${l.store ?? '-'}`)
    }
  }
  console.log(`${hits} line(s)`)
}

function rename(file: string, outDir: string, pairs: string[]) {
  const map = new Map(pairs.map(p => { const i = p.indexOf('='); if (i < 1) throw new Error(`"${p}": expected "<name in the file>=<name of the LGR product>"`); return [p.slice(0, i), p.slice(i + 1)] as [string, string] }))
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const changed: string[] = []
  for (const l of doc.lines ?? []) {
    const to = map.get(bare(l.item))
    if (to === undefined) continue
    const group = GROUP.exec(String(l.item))?.[0] ?? ''
    changed.push(`- quantity ${l.quantity}: „${bare(l.item)}" → „${to}"`)
    l.item = `${group}${to}`
    if (typeof l.name === 'string') l.name = to
  }
  // Every pair must have found its line, once: a pair that matched nothing means the name was typed differently.
  if (changed.length !== map.size) throw new Error(`${map.size} name(s) given, ${changed.length} line(s) changed: each name must match exactly one line of ${basename(file)}`)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, basename(file)), JSON.stringify(doc, null, 2))
  const readme = join(outDir, 'README.md')
  const number = doc.header?.docNumber ?? basename(file)
  writeFileSync(readme, `${existsSync(readme) ? `${readFileSync(readme, 'utf8').trimEnd()}\n\n` : ''}# Corrected copy of ${number}\n\n\`${basename(file)}\` here equals the pulled file except for these lines, which carry the name of LGR's product instead of PlusMinus's:\n\n${changed.join('\n')}\n\nWhy: the importer matches a line to a product by exact name, and LGR names these products differently.\nBooked from this folder, by number, in the document's own place in the order. The marker is the document's own, so a rerun over the day folder skips it.\n`)
  for (const c of changed) console.log(c)
  console.log(`written: ${join(outDir, basename(file))} (+ README.md). Dry-run it before booking.`)
}

if (mode === 'lines' && rest.length) lines(rest)
else if (mode === 'find' && rest.length === 2) find(rest[0], rest[1])
else if (mode === 'rename' && rest.length >= 3) rename(rest[0], rest[1], rest.slice(2))
else { console.error('usage: doc.ts lines <file> ... | doc.ts find <day dir> "<part of a name>" | doc.ts rename <file> <out dir> "<name in the file>=<LGR product name>" ...'); process.exit(2) }
