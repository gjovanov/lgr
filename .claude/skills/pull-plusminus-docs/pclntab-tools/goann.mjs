// goann.mjs — read a stripped Go PE64 (pmserver.exe, unpacked) with NO Go toolchain: Node + llvm-objdump only. Read-only.
//
// It parses runtime.pclntab itself (Go >= 1.20 layout, magic 0xfffffff1; on this build textStart is 0, so entry offsets are relative to
// ImageBase + .text) and shells out to llvm-objdump for the instructions, then annotates them: CALL targets become function names,
// RIP-relative LEA string loads become the string. Found its use reading pmapi.UserDataAdd (see the reference doc).
//
//   node goann.mjs <pe> funcs <regex>                          list functions: VA, size, name
//   node goann.mjs <pe> callers <exact function name>          who CALLs its entry (a handler is often reached through a call INTO its body)
//   node goann.mjs <pe> refs <exact function name>             direct CALL/JMP into its body, RIP-relative LEA of its entry, address stored as data
//   node goann.mjs <pe> dis <exact function name | startVA> [endVA]   annotated disassembly (llvm-objdump must be on PATH)
//
// Reading Go ABIInternal: integer args arrive in RAX, RBX, RCX, RDI, RSI, R8, R9, R10, R11 (a string is two registers: ptr, len); a callee
// spills them to its frame, so follow the stack slots. A JSON-decoded []string element is 16 bytes (ptr, len) at args+0x10*i.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const [, , path, cmd, a1, a2] = process.argv
const b = readFileSync(path)

const pe = b.readUInt32LE(0x3c)
const nsec = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20)
const imageBase = Number(b.readBigUInt64LE(pe + 24 + 24))
const secs = []
for (let i = 0; i < nsec; i++) {
  const o = pe + 24 + optSize + i * 40
  secs.push({ name: b.toString('latin1', o, o + 8).replace(/\0+$/, ''), vsize: b.readUInt32LE(o + 8), rva: b.readUInt32LE(o + 12), rawSize: b.readUInt32LE(o + 16), raw: b.readUInt32LE(o + 20) })
}
const text = secs.find(s => s.name === '.text')
const vaToOff = va => { for (const s of secs) { const r = va - imageBase; if (r >= s.rva && r < s.rva + Math.max(s.vsize, s.rawSize)) return s.raw + (r - s.rva) } return -1 }

const magic = Buffer.from([0xf1, 0xff, 0xff, 0xff, 0, 0, 1, 8])
let hdr = -1
for (let i = b.indexOf(magic); i >= 0; i = b.indexOf(magic, i + 1)) { if (b.readBigUInt64LE(i + 8) > 1000n) { hdr = i; break } }
const nfunc = Number(b.readBigUInt64LE(hdr + 8))
const textStart = Number(b.readBigUInt64LE(hdr + 24))
const base = textStart || (imageBase + text.rva)
const nameTab = hdr + Number(b.readBigUInt64LE(hdr + 32)), ftab = hdr + Number(b.readBigUInt64LE(hdr + 64))
const fn = []
for (let i = 0; i <= nfunc; i++) fn.push({ va: base + b.readUInt32LE(ftab + i * 8), funcoff: b.readUInt32LE(ftab + i * 8 + 4), name: '' })
for (let i = 0; i < nfunc; i++) {
  const fo = hdr + Number(b.readBigUInt64LE(hdr + 64)) + fn[i].funcoff
  let e = nameTab + b.readInt32LE(fo + 4), s = e
  while (b[e] !== 0) e++
  fn[i].name = b.toString('latin1', s, e)
}
// An externally linked (cgo) build puts the C runtime first in .text (pmserver's first function is at 0x140001010), so Go's
// runtime.text is NOT the section start and every entry above is off by one constant. Calibrate on structure: the right shift is
// the one at which the most entries land on a Go stack-check prologue (cmp rsp,[r14+0x10] / lea r12,[rsp-n]). GOANN_SHIFT=0x..
// overrides. pmserver build 20260805:101606: 0x460 (the "+0x460 into the handler's body" earlier readings saw was this offset).
let shift = process.env.GOANN_SHIFT ? parseInt(process.env.GOANN_SHIFT, 16) : 0
if (!process.env.GOANN_SHIFT && !textStart) {
  const prologue = o => o >= 0 && ((b[o] === 0x49 && b[o + 1] === 0x3b && b[o + 2] === 0x66 && b[o + 3] === 0x10) ||
    (b[o] === 0x4c && b[o + 1] === 0x8d && (b[o + 2] === 0x64 || b[o + 2] === 0xa4) && b[o + 3] === 0x24))
  let best = 0, bestScore = -1
  for (let s = -0x2000; s <= 0x8000; s += 0x20) {
    let score = 0
    for (let i = 0; i < nfunc; i += 7) if (prologue(vaToOff(fn[i].va + s))) score++
    if (score > bestScore) { bestScore = score; best = s }
  }
  shift = best
}
if (shift) { for (const f of fn) f.va += shift; console.error(`goann: entries shifted by ${'0x' + shift.toString(16)} (runtime.text is not the .text start)`) }
const byName = new Map(fn.slice(0, nfunc).map((f, i) => [f.name, { ...f, end: fn[i + 1].va }]))
function funcAt(va) {
  let lo = 0, hi = nfunc - 1
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (fn[m].va <= va) lo = m; else hi = m - 1 }
  return fn[lo].va <= va && va < fn[lo + 1].va ? { name: fn[lo].name, off: va - fn[lo].va } : null
}
const hex = n => '0x' + n.toString(16)

if (cmd === 'funcs') {
  const rx = new RegExp(a1)
  for (let i = 0; i < nfunc; i++) if (rx.test(fn[i].name)) console.log(`${hex(fn[i].va)} size=${fn[i + 1].va - fn[i].va} ${fn[i].name}`)
} else if (cmd === 'callers') {
  const t = byName.get(a1); if (!t) { console.error('no such function'); process.exit(1) }
  const lo = vaToOff(imageBase + text.rva), hiO = lo + text.rawSize
  for (let o = lo; o < hiO - 5; o++) {
    if (b[o] !== 0xe8) continue
    const va = imageBase + text.rva + (o - lo)
    const target = va + 5 + b.readInt32LE(o + 1)
    if (target === t.va) { const f = funcAt(va); console.log(`${hex(va)}  in ${f?.name}+${hex(f?.off ?? 0)}`) }
  }
} else if (cmd === "refs") {
  const t = byName.get(a1); if (!t) { console.error("no such function"); process.exit(1) }
  const lo = vaToOff(imageBase + text.rva), hiO = lo + text.rawSize, vaOf = o => imageBase + text.rva + (o - lo)
  const where = va => { const f = funcAt(va); return f ? f.name + "+" + hex(f.off) : "?" }
  console.log(a1 + ": [" + hex(t.va) + ", " + hex(t.end) + ")")
  let n = 0
  for (let o = lo; o < hiO - 7; o++) {
    const op = b[o]
    if (op === 0xe8 || op === 0xe9) { const tg = vaOf(o) + 5 + b.readInt32LE(o + 1); if (tg >= t.va && tg < t.end) { n++; console.log("  " + (op === 0xe8 ? "CALL" : "JMP ") + " into body  @" + hex(vaOf(o)) + "  from " + where(vaOf(o)) + "  target +" + hex(tg - t.va)) } }
    if ((op === 0x48 || op === 0x4c) && b[o + 1] === 0x8d && (b[o + 2] & 0xc7) === 0x05) { const tg = vaOf(o) + 7 + b.readInt32LE(o + 3); if (tg === t.va) { n++; console.log("  LEA entry      @" + hex(vaOf(o)) + "  from " + where(vaOf(o))) } }
  }
  const needle = Buffer.alloc(8); needle.writeBigUInt64LE(BigInt(t.va))
  for (let i = b.indexOf(needle); i >= 0; i = b.indexOf(needle, i + 1)) { n++; console.log("  DATA slot at file offset " + hex(i)) }
  console.log(n ? n + " reference(s)" : "no references found")
} else if (cmd === 'dis') {
  let start, end
  if (/^0x/i.test(a1)) { start = parseInt(a1, 16); end = parseInt(a2, 16) } else { const t = byName.get(a1); if (!t) { console.error('no such function'); process.exit(1) } start = t.va; end = t.end }
  const r = spawnSync('llvm-objdump', ['-d', '-M', 'intel', '--no-show-raw-insn', `--start-address=${hex(start)}`, `--stop-address=${hex(end)}`, path], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 })
  const strAt = (va, max = 60) => {
    const o = vaToOff(va); if (o < 0) return null
    let s = ''
    for (let i = 0; i < max && o + i < b.length; i++) { const c = b[o + i]; if (c === 0) break; if (c < 9 || (c > 13 && c < 32)) return s.length >= 2 ? s : null; s += String.fromCharCode(c) }
    // UTF-8 for Cyrillic
    return Buffer.from(s, 'latin1').toString('utf8')
  }
  for (const line of r.stdout.split(/\r?\n/)) {
    let out = line
    const call = /\bcall\s+(?:qword ptr )?(0x[0-9a-f]+)\b/i.exec(line)
    if (call && !line.includes('[')) { const f = funcAt(parseInt(call[1], 16)); if (f) out += `    ;; → ${f.name}${f.off ? '+' + hex(f.off) : ''}` }
    const rip = /#\s*(0x[0-9a-f]+)/i.exec(line)
    if (rip && /\blea\b/.test(line)) { const s = strAt(parseInt(rip[1], 16)); if (s) out += `    ;; "${s.replace(/\n/g, '\\n')}"` }
    console.log(out)
  }
}
