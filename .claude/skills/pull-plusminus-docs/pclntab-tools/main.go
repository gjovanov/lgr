// pclntab-tools: reverse-engineering helpers for pmserver.exe (PlusMinus POS server),
// a stripped Windows PE Go binary where `go tool nm`/`go tool objdump` and radare2's
// `aang` all fail to locate runtime.pclntab (they require named COFF symbols / a
// `.gopclntab`-style section marker that this build's `-ldflags="-s"` strips, and that
// Windows PE Go binaries never carry the way ELF ones do). These tools route around
// that by scanning for pclntab's own magic number directly, then feeding the found
// bytes into the REAL, standard-library `debug/gosym` package -- not a hand-rolled
// parser. See ../plusminus-mobile-api-reference.md ("Binary-level follow-up") for the
// full story, what's been found, and what's still open.
//
// Built against a downloaded Go 1.27.3 toolchain in this investigation; any reasonably
// modern Go (1.21+) should work, since this uses only `debug/pe`, `debug/gosym`, and
// the vendored `golang.org/x/arch/x86/x86asm` (the same decoder `go tool objdump` itself
// uses). Build: `go mod tidy && go build -o pclntab-tools.exe .`
//
// Subcommands (binary.exe <sub> ...):
//   locate <pmserver.exe>
//       Find pclntab, print nfunc/section info and a sanity check (the globally
//       smallest function's entry address should land exactly on .text's start).
//   list <pmserver.exe> [nameFilter]
//       Dump every function name+entry address (optionally filtered by substring).
//   calls <pmserver.exe> <startVA> <endVA> <name=0xAddr> [<name=0xAddr> ...]
//       Scan ONLY the given [start,end) range for direct CALL rel32 (opcode 0xE8)
//       instructions targeting any of the given addresses.
//   findcallers <pmserver.exe> <name=0xAddr> [<name=0xAddr> ...]
//       Scan the ENTIRE .text section for direct calls to any of the given targets,
//       reporting which named function each call site falls inside. Use this to find
//       who calls a KNOWN-interesting function anywhere in the binary, instead of
//       guessing which function might be the caller.
//   allcalls <pmserver.exe> <startVA> <endVA>
//       Enumerate EVERY direct call inside [start,end), resolve each target to a
//       name via the real function table, and print deduplicated hit counts. Use
//       this on a function you suspect is a dispatcher, to see its whole callee set
//       at once rather than checking guessed targets one at a time.
//   findcallsite <pmserver.exe> <startVA> <endVA> <targetVA>
//       Find the exact address of every CALL inside [start,end) whose target equals
//       targetVA exactly (including a non-entry offset, e.g. "func+0x280") -- use
//       this after `allcalls` points at an interesting callee, to find exactly where
//       in the caller it's invoked from, so you can disassemble the argument setup.
//   disasm <pmserver.exe> <startVA> <endVA>
//       Decode x86-64 instructions in [start,end), labeling any CALL/JMP target that
//       lands on a known function. Always prints each instruction's raw `len` and
//       `bytes` explicitly (not just the pretty-printed mnemonic) -- trust THAT when
//       manually cross-checking byte boundaries, not arithmetic on printed addresses.
//       (A real investigation bug this session: a "decode desync" that turned out to
//       be a manual transcription error, caught only by comparing raw bytes directly.)
//
// All VA/address arguments are hex, with or without a leading "0x".
package main

import (
	"bytes"
	"debug/gosym"
	"debug/pe"
	"encoding/binary"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/arch/x86/x86asm"
)

type kv struct {
	name string
	n    int
}

// peInfo holds what every subcommand needs: the raw bytes, the parsed function
// table, and the VA<->file-offset conversion for .text.
type peInfo struct {
	data        []byte
	tab         *gosym.Table
	text        uint64 // runtime VA of .text's start (== imageBase + .text RVA)
	textRaw     uint32 // file offset of .text
	textVA      uint32
	textSize    uint32
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: pclntab-tools <locate|list|calls|findcallers|allcalls|findcallsite|disasm> <pmserver.exe> ...")
		os.Exit(2)
	}
	sub, path := os.Args[1], os.Args[2]
	rest := os.Args[3:]
	info := load(path)

	switch sub {
	case "locate":
		cmdLocate(info)
	case "list":
		filter := ""
		if len(rest) > 0 {
			filter = rest[0]
		}
		cmdList(info, filter)
	case "calls":
		mustArgs(rest, 3, "calls <start> <end> <name=0xAddr>...")
		cmdCalls(info, parseHex(rest[0]), parseHex(rest[1]), rest[2:])
	case "findcallers":
		mustArgs(rest, 1, "findcallers <name=0xAddr>...")
		cmdFindCallers(info, rest)
	case "allcalls":
		mustArgs(rest, 2, "allcalls <start> <end>")
		cmdAllCalls(info, parseHex(rest[0]), parseHex(rest[1]))
	case "findcallsite":
		mustArgs(rest, 3, "findcallsite <start> <end> <targetVA>")
		cmdFindCallSite(info, parseHex(rest[0]), parseHex(rest[1]), parseHex(rest[2]))
	case "disasm":
		mustArgs(rest, 2, "disasm <start> <end>")
		cmdDisasm(info, parseHex(rest[0]), parseHex(rest[1]))
	default:
		fmt.Fprintln(os.Stderr, "unknown subcommand:", sub)
		os.Exit(2)
	}
}

// ---- shared loading / scanning ----

func load(path string) *peInfo {
	data, err := os.ReadFile(path)
	must(err)
	f, err := pe.Open(path)
	must(err)
	defer f.Close()
	oh, ok := f.OptionalHeader.(*pe.OptionalHeader64)
	must2(ok, "expected a PE32+ (64-bit) binary")
	var textVA, textRaw, textSize uint32
	for _, s := range f.Sections {
		if s.Name == ".text" {
			textVA, textRaw, textSize = s.VirtualAddress, s.Offset, s.VirtualSize
		}
	}
	must2(textVA != 0 || textRaw != 0, "no .text section found")
	text := oh.ImageBase + uint64(textVA)

	// pclntab's own magic number, current since Go 1.20 (confirmed from the real
	// internal/abi/symtab.go shipped with the Go toolchain used for this -- do not
	// trust this constant from memory for a binary built with a much older/newer Go;
	// re-derive it from a matching toolchain's internal/abi/symtab.go if `locate`
	// reports zero candidates).
	magic := []byte{0xf1, 0xff, 0xff, 0xff}
	var tab *gosym.Table
	for i := 0; i+16 <= len(data); {
		idx := bytes.Index(data[i:], magic)
		if idx < 0 {
			break
		}
		pos := i + idx
		// Sanity check mirrors runtime's own parsePclnTab guard: 2 zero pad bytes,
		// a plausible pc-quantum, a plausible pointer size.
		if data[pos+4] == 0 && data[pos+5] == 0 &&
			(data[pos+6] == 1 || data[pos+6] == 2 || data[pos+6] == 4) &&
			(data[pos+7] == 4 || data[pos+7] == 8) {
			nfunc := int(binary.LittleEndian.Uint64(data[pos+8 : pos+16]))
			if nfunc > 0 && nfunc < 2_000_000 {
				lt := gosym.NewLineTable(data[pos:], text)
				if t, err := gosym.NewTable(nil, lt); err == nil && len(t.Funcs) > 100 {
					tab = t
					break
				}
			}
		}
		i = pos + 1
	}
	must2(tab != nil, "no valid pclntab candidate found -- see the magic-number comment above")
	sort.Slice(tab.Funcs, func(i, j int) bool { return tab.Funcs[i].Entry < tab.Funcs[j].Entry })
	return &peInfo{data: data, tab: tab, text: text, textRaw: textRaw, textVA: textVA, textSize: textSize}
}

func (p *peInfo) toFileOff(va uint64) int64 { return int64(va-p.text) + int64(p.textRaw) }

// containing returns "funcName" if va is exactly a function's entry, else
// "funcName+0xOFFSET" for the nearest preceding function -- which is only
// meaningful if va genuinely falls inside real code, not padding/another
// function's tail; corroborate with `allcalls`/`disasm` before trusting a non-zero
// offset result.
func (p *peInfo) containing(va uint64) string {
	idx := sort.Search(len(p.tab.Funcs), func(i int) bool { return p.tab.Funcs[i].Entry > va })
	if idx == 0 {
		return fmt.Sprintf("0x%x(no symbol)", va)
	}
	fn := p.tab.Funcs[idx-1]
	if va == fn.Entry {
		return fn.Sym.Name
	}
	return fmt.Sprintf("%s+0x%x", fn.Sym.Name, va-fn.Entry)
}

// scanCalls returns every (callSiteVA, targetVA) for direct `CALL rel32` (0xE8)
// instructions inside the given VA range.
func (p *peInfo) scanCalls(start, end uint64) [][2]uint64 {
	so, eo := p.toFileOff(start), p.toFileOff(end)
	var out [][2]uint64
	for off := so; off < eo-5; off++ {
		if p.data[off] != 0xe8 {
			continue
		}
		rel := int32(binary.LittleEndian.Uint32(p.data[off+1 : off+5]))
		insnVA := start + uint64(off-so)
		targetVA := uint64(int64(insnVA) + 5 + int64(rel))
		out = append(out, [2]uint64{insnVA, targetVA})
	}
	return out
}

// ---- subcommands ----

func cmdLocate(p *peInfo) {
	fmt.Printf("pclntab candidate accepted: %d functions\n", len(p.tab.Funcs))
	fmt.Printf("text VA=0x%x size=0x%x\n", p.text, p.textSize)
	min := p.tab.Funcs[0].Entry
	fmt.Printf("sanity check: globally smallest function entry=0x%x, delta from .text start=%d (should be 0)\n",
		min, int64(min)-int64(p.text))
}

func cmdList(p *peInfo, filter string) {
	for _, fn := range p.tab.Funcs {
		if filter == "" || strings.Contains(fn.Sym.Name, filter) {
			fmt.Printf("0x%x\t%s\n", fn.Entry, fn.Sym.Name)
		}
	}
}

func cmdCalls(p *peInfo, start, end uint64, nameAddrs []string) {
	targets := parseNameAddrs(nameAddrs)
	fmt.Fprintf(os.Stderr, "scanning 0x%x..0x%x (%d bytes)\n", start, end, end-start)
	for _, c := range p.scanCalls(start, end) {
		if name, ok := targets[c[1]]; ok {
			fmt.Printf("CALL @0x%x -> %s (0x%x)\n", c[0], name, c[1])
		}
	}
}

func cmdFindCallers(p *peInfo, nameAddrs []string) {
	targets := parseNameAddrs(nameAddrs)
	start, end := p.text, p.text+uint64(p.textSize)
	fmt.Fprintf(os.Stderr, "scanning full .text 0x%x..0x%x\n", start, end)
	for _, c := range p.scanCalls(start, end) {
		if name, ok := targets[c[1]]; ok {
			fmt.Printf("CALL to %s (0x%x) at 0x%x, inside %s\n", name, c[1], c[0], p.containing(c[0]))
		}
	}
}

func cmdAllCalls(p *peInfo, start, end uint64) {
	counts := map[string]int{}
	calls := p.scanCalls(start, end)
	for _, c := range calls {
		counts[p.containing(c[1])]++
	}
	var list []kv
	for k, v := range counts {
		list = append(list, kv{k, v})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].name < list[j].name })
	fmt.Fprintf(os.Stderr, "%d unique callees, %d total call sites in range\n", len(list), len(calls))
	for _, e := range list {
		fmt.Printf("%4d  %s\n", e.n, e.name)
	}
}

func cmdFindCallSite(p *peInfo, start, end, want uint64) {
	for _, c := range p.scanCalls(start, end) {
		if c[1] == want {
			fmt.Printf("found CALL @0x%x -> 0x%x\n", c[0], c[1])
		}
	}
}

func cmdDisasm(p *peInfo, start, end uint64) {
	so, eo := p.toFileOff(start), p.toFileOff(end)
	buf := p.data[so:eo]
	pc := start
	for len(buf) > 0 {
		inst, err := x86asm.Decode(buf, 64)
		if err != nil || inst.Len == 0 {
			n := 8
			if len(buf) < n {
				n = len(buf)
			}
			fmt.Printf("0x%x: (decode error: %v) % x\n", pc, err, buf[:n])
			buf = buf[1:]
			pc++
			continue
		}
		line := x86asm.GNUSyntax(inst, pc, nil)
		extra := ""
		if len(buf) >= 5 && (buf[0] == 0xe8 || buf[0] == 0xe9) {
			rel := int32(binary.LittleEndian.Uint32(buf[1:5]))
			target := uint64(int64(pc) + 5 + int64(rel))
			if l := p.containing(target); !strings.Contains(l, "(no symbol)") {
				extra = "  ; -> " + l
			}
		}
		fmt.Printf("0x%x: len=%-2d bytes=%-20x %-40s%s\n", pc, inst.Len, buf[:inst.Len], line, extra)
		buf = buf[inst.Len:]
		pc += uint64(inst.Len)
	}
}

// ---- helpers ----

func parseNameAddrs(args []string) map[uint64]string {
	m := map[uint64]string{}
	for _, a := range args {
		i := strings.LastIndexByte(a, '=')
		must2(i >= 0, "expected name=0xADDR, got "+a)
		m[parseHex(a[i+1:])] = a[:i]
	}
	return m
}
func mustArgs(args []string, n int, usage string) {
	must2(len(args) >= n, "usage: "+usage)
}
func parseHex(s string) uint64 {
	s = strings.TrimPrefix(s, "0x")
	v, err := strconv.ParseUint(s, 16, 64)
	must(err)
	return v
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
func must2(ok bool, msg string) {
	if !ok {
		panic(msg)
	}
}
