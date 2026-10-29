# Handover: PlusMinus direct-API extraction — continue on Opus 5.5

Written 2026-10-27 at the end of a long Sonnet 5 session, for a fresh session. **Use the
strongest available model (Opus 5.5) and real effort on this** — it's live binary
reverse-engineering against a production system with no documentation, and it has already
produced one wrong conclusion that cost real time to walk back (see "What went wrong" below).
This is not a routine task.

## The original ask (verbatim)

> yesterday we created the skill: pull-plusminus-docs. However, this is quite cumbersome
> process, requires screen share, clicking on the plusminus app etc. Long-term goal is to
> migrate Regal org from PlusMinus to LGR and now we are doing daily pdf export from PlusMinus
> and import in LGR via skills. This proves a very error prone process partly due to OCR, partly
> due to formattings e.g. same line item split on 2 pdf pages. So it would be great if we can
> directly extract the data from PlusMinus using our account (credentials in
> C:\dev\gjovanov\plusminus.important - format: un: XXXX {newline} pw: YYYY) accessible via:
> https://100.65.4.26:7000/login (pls make note that we should disregard the tls errors). Pls
> extact the same data (invoices, storazp, skrazp, stockAvailablity excel).

**Note the scope**: the ultimate goal is all four document families — sales invoices
(`invoicem`), stock receipts (`stokrazp`), transfers (`sklrazp`), and the stock snapshot
(`storeAvailability`) — not just invoices. Invoices became the concrete first target because
that's what got tried live.

## The prompt that started today's live investigation (verbatim)

> now using this API, extract all invoices from yesterday using this temp token
> (cacf643b-d25f-4788-891d-dd84377919b3)

That specific token turned out to be a `/server` admin-console token, not a `/mobile` session
token (see below) — don't assume it's still valid; it may also have rotated since. If you need
one, get a fresh one the same way: `POST /login` with the real credentials, read the hidden
`#token` input's `value=` out of the response HTML.

## Read this first

**`../plusminus-mobile-api-reference.md`** — the full 554-call catalog (read vs. write
heuristic), the "Field verification (2026-10-27)" section (everything proven live), and the
"Binary-level follow-up" section (everything proven by reading the actual dispatcher's machine
code). That doc is the primary record; this handover is a map to it plus what to do next. Read
its "Binary-level follow-up" section fully before touching the live server again — it's a
numbered, step-by-step account including the one wrong conclusion and its correction.

## Where this actually stands, in one paragraph

Login, company context, object context, `docTypes`, `documentExists` — all confirmed working
live against the real server. The `document(type, number)` call that should return an invoice's
content returns empty for a record *proven* to exist. Reading the real dispatcher's x86-64 code
(not guessing) proved: (1) dispatch genuinely is name-based — there's a literal 8-byte string
comparison against `"document"` inside `main.processRequest`; (2) it falls through correctly to
a direct `CALL` into `pmapi.document+0x280`, which does touch the embedded Firebird-family
database (`fkb33.(*Tx).Get`/`.AddValue`/`.Del`/`.write`); (3) immediately before that call there
is a hard gate — `cmp $0x2,%r10 ; jbe <away>` — that diverts away from the real logic unless the
argument count is **3 or more**. Every live call this session made used exactly 2 arguments.
That is the full, mechanistic explanation for every empty result seen. **The third argument's
correct value is the one open question.** Three guesses at it (the object identifier, in three
different argument positions) were tried and all three still came back empty — so it's not
simply "add the object there," though that remains plausible in a slightly different form (see
next steps).

## What went wrong (read this so you don't repeat it)

Early in the binary analysis, `pmapi.Document` and `pmapi.document` were disassembled (only
their first ~60-100 instructions) and found to compare input against JSON-looking literals
(`"quantity"`, `"no"`). This was reported — in this doc and in chat — as **definitive proof**
that both functions are unrelated JSON utilities, disproving the entire naming-convention
approach. That conclusion was wrong, and the error was methodological: it generalized from a
function's first hundred bytes to its entire multi-KB body. Reading `pmapi.document`'s *full*
body (with the `allcalls` tool, scoped to its whole span, not just its prologue) revealed real
database access. Always read a function's full body (or at least scan its full `allcalls`
output) before concluding what it does — a prologue can do something that looks unrelated to the
function's actual job (mode selection, validation, a fast-path check) before the real logic.

## Tooling — now persisted, use it directly

**`./main.go`** in this same directory (`pclntab-tools/`) is a consolidated, checked-in,
already-verified-to-build tool with subcommands `locate`, `list`, `calls`, `findcallers`,
`allcalls`, `findcallsite`, `disasm`. Read its top-of-file comment block and the sibling
`README.md` for exactly what each does and when to reach for it. It was rebuilt from five
separate scratch scripts written during today's investigation (the scratch directory they lived
in does not survive between sessions — this consolidated, committed copy is the durable one).

Build: `go mod tidy && go build -o pclntab-tools.exe .` (needs Go 1.21+, not necessarily the
Go 1.26 that built `pmserver.exe` itself). A `vendor/` directory is checked in so this also
builds with **zero network access**: `go build -mod=vendor -o pclntab-tools.exe .`. No system Go
was available in today's environment; a portable one was fetched from
`https://dl.google.com/go/go1.27.3.windows-amd64.zip` if you need one too.

**Not checked in** (third-party binaries, too large/inappropriate for this public repo — refetch
as needed):
- `pmserver.exe` itself: pull fresh over `roomler ssh` using the same transport `pull.sh` (in
  this skill's parent directory) uses — base64 chunks, SHA-256 verified, against device
  `Regal-Elena-PZ` (hex id `6a61228270bf9a4044cd615c`). It's small (11MB) and was pulled this
  session in a few batched calls; check `pull.sh`'s `fetch.sh`-style pattern or just write a
  short script that does: PowerShell `[IO.File]::ReadAllBytes` → gzip in-memory →
  `Convert.ToBase64String` in ≤600KB chunks → reassemble + `sha256sum` check locally.
- **UPX** (to unpack it: 11MB → 27MB, `upx -d pmserver.exe`): public release at
  `github.com/upx/upx/releases`.
- Radare2 was tried (`r2blob-*-w64.zip` from `github.com/radareorg/radare2/releases`) and its
  dedicated Go-binary analyzer `aang` **did not work** on this binary (misdetects it as `lang c`,
  even with `e bin.lang=go` forced) — don't bother re-fetching it for this specific task; the
  `debug/gosym`-based approach in `pclntab-tools` is what actually worked, and r2 added nothing.

## Credentials / access (sensitive — don't commit, don't paste into any file that gets pushed)

- Username/password: `C:\dev\gjovanov\plusminus.important` (format: `un: <value>` / `pw: <value>`
  on separate lines, UTF-8 with a possible BOM).
- Base URL: `https://100.65.4.26:7000` — self-signed cert, every request needs TLS verification
  disabled (`rejectUnauthorized: false` in `fetch`'s `tls` option under Bun, or curl `-k`).
- `/mobile` is the business-data RPC surface (`POST`, body `["methodName", ...args]`, header
  `Authorization: <session token>`). `userLogin(un, pw)` returns a 36-char token on success.
- `/server` is a **separate, smaller** admin-console surface (licensing, backup, connected
  clients) authorized with a **different kind of token** — scrape it from the hidden `#token`
  input in the HTML returned by `POST /login` with the same credentials. The two token kinds are
  **not interchangeable**; confusing them was an early mistake this session (see the reference
  doc's "Field verification" section for how that was diagnosed with negative controls).
- **The `/mobile` account has exactly one session slot, shared with the till's live GUI app.**
  `userLogin` returns `"-2"` if the till's PlusMinus desktop app already holds it.
  `disconnectClient("Администратор")` over `/server` (with an admin token) evicts it —
  **this is disruptive to a live, possibly-in-use retail register; confirm with the user before
  doing it**, exactly as was done, each time, this session. Oddity to note: late in this session,
  `disconnectClient` started returning `"false"` instead of the `"true"` it returned earlier,
  and did not actually evict the lingering session (`clients()` still showed `"Администратор"`
  connected afterward). Not resolved — possibly a stale/duplicate-named-connection edge case,
  possibly the admin token itself nearing some expiry. Check `clients()` before assuming the slot
  is free.
- Known real record for testing: invoice type `"-ФЕ"`, number `"3000101637"` — the first invoice
  of business day 2026-10-26 (16 invoices total that day, numbered …637 through …652, per memory
  `plusminus-export-over-roomler`). `documentExists("-ФЕ","3000101637","")` returns `"true"`.

## Key addresses from this session (re-verify if `pmserver.exe` has been rebuilt)

`pmserver.exe` at the time of this investigation: `buildTime` = `20260805:101606`. If a fresh
pull reports a different `buildTime`, these addresses may have shifted — rerun
`pclntab-tools locate` and `pclntab-tools list <filter>` to refresh them rather than trusting
these numbers blindly.

| what | address |
|---|---|
| pclntab magic `0xfffffff1` found at file offset | `0x15f2e80` |
| `main.processRequest` (the giant dispatcher, 148,384 bytes) | `0x140555140` |
| `main.mobileRequest` (small, ~2.4KB, the `/mobile` HTTP entry point) | `0x1405547c0` |
| `pmapi.document` (lowercase — the real handler; full body, not just prologue) | `0x1403a0380` |
| `pmapi.Document` (capitalized — a *different* function, genuinely unrelated) | `0x1403a01a0` |
| `pmapi.DocumentExists` (confirmed working live) | `0x1403c5160` |
| the exact `CALL` site inside `processRequest` reaching `pmapi.document+0x280` | `0x140557660` |

## Suggested next steps, in priority order

1. **Re-pull `pmserver.exe`, re-run `pclntab-tools locate`**, confirm the addresses above still
   hold (or get fresh ones if the binary changed).
2. **Read the register-loaded struct fields at the real call site** (disassemble around
   `0x140557660`, already captured in the reference doc's "Binary-level follow-up" step 6 — but
   go further than this session did: trace backward from `mov 0x10(%rdx),%rdi` /
   `mov 0x18(%rdx),%rsi` / `mov 0x20(%rdx),%r8` / `mov 0x28(%rdx),%r9` to find where `%rdx` itself
   comes from — it's loaded from `0x258(%rsp)` a few instructions earlier, which is almost
   certainly the unmarshaled JSON args array's backing struct (a Go slice header: ptr+len+cap, or
   an array of `interface{}` headers). Figuring out that struct's layout tells you exactly what
   each of the 4 variable argument slots (not just "how many") actually wants.
3. **Try a live 3-argument call with something other than the object identifier** as the third
   value — candidates not yet tried: an empty string (bare `""`, different from previous attempts
   which paired type+number+object — try type+number+`""` specifically, since the gate only
   checks *count*, not content, so a blank third argument might be exactly what the real logic
   wants, e.g. a reserved/optional filter parameter), or a boolean-shaped value (`true`/`false`,
   `"1"`/`"0"`) given how many other calls in the 554-method catalog take trailing boolean-ish
   flags. Try 4-argument calls too, in case the real minimum is higher than 3 and the `<=2` gate
   just happens to also reject 3.
4. **Consider that `pmapi.document`'s own sibling closures** (`pmapi.document.func1/func2/func3`,
   at addresses near `0x1403a1540`/`0x1403a1ca0`/`0x1403a2fa0` per `pclntab-tools list document`)
   may be where the *actual* lookup-by-type-and-number happens, with the main function body being
   mostly argument validation/dispatch to one of them — `allcalls` on each closure's own span
   would show this quickly.
5. If this resolves: update `plusminus-mobile-api-reference.md`'s `document` entry from "unknown
   argument shape" to the confirmed real signature, and **only then** consider whether to extend
   `pull-plusminus-docs` itself to use the API path — the GUI/remote-desktop procedure remains
   the proven fallback for actual data needs in the meantime, independent of how this
   investigation goes.

## Hard constraints — same ones that applied all session

- Never call anything in the fiscal-device or `/restore` (full-database-replace) sections of the
  reference doc, ever, from exploration.
- Confirm with the user before evicting the till's live session (`disconnectClient`/
  `disconnectAll`) — it's a real, disruptive action against a store that may be mid-transaction.
- This is `gjovanov/lgr`, a **public** repository. Never commit `pmserver.exe` itself,
  credentials, tokens, or anything from `C:\dev\gjovanov\plusminus.important`.
- Calling `document`, `docTypes`, `documentJournalEntries` (or almost certainly any other
  method) with **fewer** arguments than the real minimum panics the connection
  (`ECONNRESET`) — the server process itself survives (Go's `net/http` recovers per-request
  panics), but don't be alarmed by it, and don't read it as a sign anything is broken beyond that
  one request.
