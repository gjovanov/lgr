# pclntab-tools

Reverse-engineering helpers for `pmserver.exe` (the legacy PlusMinus POS server) built
during the 2026-10-27 live investigation — see
[`../plusminus-mobile-api-reference.md`](../plusminus-mobile-api-reference.md)
("Binary-level follow-up" section) for the full story, and the handover doc in this
same directory for exactly where that investigation stands and what to do next.

**Why this exists:** `go tool nm`, `go tool objdump`, and radare2's Go-binary
analyzer (`aang`) all fail on this specific binary — it's a Windows PE Go binary
whose COFF symbol table was stripped (`-ldflags="-s"`), and the tools' PE loaders
require named `runtime.pclntab`/`runtime.epclntab` symbols with no fallback. The
`pclntab` bytes themselves are present regardless (Go's function-name table
survives `-s`/`-w` stripping) — they're just not reachable *by name* through those
tools. This locates them by scanning for the magic number directly, then hands the
found bytes to the real standard-library `debug/gosym` package — not a hand-rolled
parser.

## Build

```bash
go mod tidy      # or: go mod vendor, then go build -mod=vendor (works with no network)
go build -o pclntab-tools.exe .
```

Needs Go 1.21+. The investigation itself downloaded a portable Go 1.27.3 toolchain
(`dl.google.com/go/go1.27.3.windows-amd64.zip`) since no system Go was available —
any reasonably current Go works fine for *this* tool; it's unrelated to the Go
version that built `pmserver.exe` (1.26) except that the pclntab magic number
(`0xfffffff1`) must match what that version actually emits. See the comment at the
top of `main.go` if `locate` reports zero candidates on a future rebuild of
`pmserver.exe` — that's the first thing to re-check.

## Usage

Run `./pclntab-tools.exe` with no args for the subcommand list, or see the long
comment block at the top of `main.go` — it documents each subcommand (`locate`,
`list`, `calls`, `findcallers`, `allcalls`, `findcallsite`, `disasm`) with exactly
when to reach for it. The short version: don't guess a dispatcher's callees one
name at a time — use `allcalls` on the suspect function first and read its *whole*
real callee set, then `findcallsite` to find exactly where a specific interesting
callee is invoked from, then `disasm` the instructions right before that call site
to see the real argument setup.

**You still need `pmserver.exe` itself** — it is not, and should not be, committed
here (third-party vendor binary; this repo is public). Pull it fresh with
[`pull.sh`](../pull.sh)'s transport pattern over `roomler ssh` from the store PC
(`Regal-Elena-PZ`, agent `6a61228270bf9a4044cd615c`), then `upx -d` it (the public
[UPX releases](https://github.com/upx/upx/releases)) — it's UPX-packed, 11MB → 27MB
unpacked. All tools here expect the **unpacked** copy.
