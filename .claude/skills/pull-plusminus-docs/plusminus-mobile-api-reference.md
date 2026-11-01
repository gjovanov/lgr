# PlusMinus /mobile RPC reference -- read-only vs. write/mutating

> Reverse-engineered method inventory of the legacy PlusMinus POS server that regal-pz still
> runs (store PC `Regal-Elena-PZ`, `C:\pmserver\pmserver.exe`). Written to support the
> long-term goal in [[pull-plusminus-docs]]: replacing the manual remote-desktop GUI export with
> a direct API pull. Most of this doc is still an unexercised heuristic. A 2026-10-27 live
> session (see "Field verification" and "Binary-level follow-up" below) got a real `/mobile`
> session working end to end, confirmed `docTypes`/`documentExists`/`companySelect`/`objects`
> against the real server, and **read the actual dispatcher's machine code** to confirm
> `document("-ФЕ","3000101637")` genuinely reaches the real handler (`pmapi.document`, which
> does touch the embedded database) but is gated behind an argument-count check requiring **3+
> arguments**, not the 2 every call so far has used. The missing third argument is the
> **single remaining open question** -- see "Binary-level follow-up" step 7 and the handover doc
> in [`pclntab-tools/`](pclntab-tools/) for exactly where to pick this up.
>
> **Resolved 2026-10-27, same day, a later session on this question:** there was no missing
> argument. Reading the vendor's own embedded client JS (not more disassembly) showed `document`
> is a plain 2-argument passthrough whose real key is `date+"\\"+num` from a `documents()` listing
> entry -- every earlier live attempt used the wrong key (`type`,`invoiceNumber`), not too few
> arguments. Separately, `documents()` itself silently reorders and pads its 3 JS-level
> parameters into **6 wire arguments** before calling `request()` -- a 3-argument call like this
> session made is genuinely under its real minimum, which is the actual, fully mechanistic
> explanation for the `ECONNRESET` the step-6/7 gate-reading was reaching for. Both fixes were
> live-verified the same session across every document family that had entries that day
> (`-ФЕ`/`СТ`/`СР`) plus the stock snapshot (`items()`), with exact-match counts against the known
> record for 2026-10-26. **The API route is now a working skill**: see
> [`pull-plusminus-api`](../pull-plusminus-api/SKILL.md). This section is kept as the record of
> the investigation and its correction, not as the current state of the question -- the "Binary
> follow-up" disassembly reasoning (the gate itself, the `pmapi.document` body) was real and is
> still accurate as a description of the binary; it just wasn't the actual blocker.

## Provenance -- how this list was produced

1. Pulled `C:\pmserver\pmserver.exe` off the store PC over `roomler ssh` (base64, SHA-256
   verified, same transport as [`pull.sh`](pull.sh)) and `C:\pmserver\help\pmserver.pdf`
   (the install/admin manual -- covers Windows-service setup and the backup/restore buttons
   only; nothing about the RPC surface).
2. The binary is a UPX-packed Go 1.26 executable (`pmserver.exe`, 11.1 MB -> 27.2 MB unpacked
   with the public `upx -d`). It embeds its own web UI (admin console + the desktop/mobile
   client app) as literal JS source inside the binary's data section -- Electron/webview apps
   ship their JS uncompiled, so it reads straight out of a string dump.
3. Every `pm.<name> = function(...) { return request(["<rpcName>", ...]) }` wrapper in that
   embedded JS was extracted mechanically: **554 wrapper functions**, calling
   **548 distinct underlying RPC names** through **549 (name, arity)
   call signatures** -- the one-signature-short-of-matching-names case is
   `fpOpenFiscalReceipt`, called with 7 args from one wrapper and 8 from another, so it gets
   two rows below under the same name. Separately, 6 names are reachable through
   more than one wrapper -- same call, different JS-side alias (e.g. `readFile` /
   `readFileServer`); both spellings are listed together. "554" in the task that produced
   this doc is the wrapper count; the tables below are organized by the
   549 call signatures.
4. The Go binary's own symbol table (`main.*`, `pmapi.*` -- stripped but not obfuscated)
   confirms the server-side handler names match the client-side call names 1:1, and that the
   business logic lives in an internal `pmapi` package wrapping an embedded Firebird-family
   database (`fkb33`, files `plusmin.fkb` / `plusmin.dat`).
5. **Read-only vs. write is a NAMING-CONVENTION HEURISTIC, not a tested property.** See
   "Method" below for exactly what it does and does not account for. The task that produced
   this doc said as much: "this list is not conclusive."

### What was actually tried against the live server

- `["userLogin", "<account>", "<password>"]` over `POST /mobile` returned `"-2"`, which the
  client JS decodes as "a user with that name is already connected to the server"
  (the Bulgarian string: "Има потребител със същото име, който се е свързал със сървъра") --
  i.e. the desktop PlusMinus app running ON the store PC was already holding that account's
  session. **No RPC call in this document has been exercised with a live session.** The error
  codes the client recognizes are `"-1"` (bad username/password) and `"-2"` (already
  connected); anything else is treated as a session token.
- A handful of harmless-looking admin-console calls (`version`, `buildTime`, `clients`,
  `getLongProcessStatus`, `hardwareId`) were called over the **separate, smaller** `/server`
  endpoint (see the appendix) using the fixed token the server's own admin HTML page embeds --
  that endpoint is unrelated to user accounts and didn't hit the "-2" conflict.

## Field verification (2026-10-27)

A later session got a value that looked like a session token handed in directly ("use this
token"). It turned out to be a **`/server` admin-console token, not a `/mobile` session
token** -- confirmed with negative controls (a bad/missing token returns `""` from `/server`;
this token returned real data from four different calls). That distinction, only suspected
before, is now proven: the login page at the server's root URL is the admin console, and there
is no page that hands out a `/mobile` token to copy -- that only comes back as the response of
a successful `userLogin`/`userLoginByCode` call.

**Confirmed working, live, with real responses:**
- `userLogin(account, password)` over `/mobile` -- returns a 36-char token on success. It had
  returned `"-2"` (account already connected) because the till's own PlusMinus GUI was holding
  the single account slot. The admin token's `disconnectClient("Администратор")` over `/server`
  freed it immediately, and login then succeeded. **This is disruptive** -- it evicts whatever
  that account is doing right now, GUI included -- and was done only after explicit
  confirmation, not by default.
- `companySelect("РЕГАЛ   ООД")` -> `"true"`; `currentCompany()` then returns that name.
  Required: `currentCompany()` was empty before it ran.
- `docTypes("", "")` -> the full type catalog, comma-separated:
  `+ФЕ,-П,-ПП,-ПС,-ФЕ,-ФЕА,-ФП,ББ,БР,ЗП,КБ,КП,МО,ОФ,П,П79,ПА,ПКО,ПР,РКО,СИ,СР,СТ`. Matches
  `export-gui.md`'s journal table exactly. **`-ФЕ` is the confirmed sales-invoice type code.**
  ⚠ Calling `docTypes` with zero args instead of the documented two crashes the connection
  (`ECONNRESET`) -- the server process itself stays up (confirmed via `/server` `clients()`
  immediately after), but that one request's connection resets hard. Supplying fewer arguments
  than a handler expects panics it; this is apparently true across this whole surface, not
  particular to `docTypes`.
- `objects("", "")` -> `["   ", "БЕЗСКЛАД", "ОБЕКТИ:СКЛАД", "ОБЕКТИ:СКЛАД - 1"]`. **This
  corrects a guess**: the real object/warehouse identifier carries an `"ОБЕКТИ:"` prefix
  (`"ОБЕКТИ:СКЛАД - 1"`, not the bare `"СКЛАД - 1"` that `export-gui.md`'s plain-English
  description of the salesAnalysis screen would suggest). `setCurrentObject("ОБЕКТИ:СКЛАД - 1")`
  returns empty (not an error -- `getCurrentObject()` afterward is also empty, so whether it
  actually took effect is unconfirmed either way).
- `documentExists("-ФЕ", "3000101637", "")` -> `"true"` for a real invoice number from the
  2026-10-26 manual export (memory `plusminus-export-over-roomler`). The reverse argument order,
  `documentExists("3000101637", "-ФЕ", "")`, correctly returns `"false"` -- confirming
  **(type, number, _) is the right argument order** for at least this call.

**Still open -- the actual content-retrieval call is unknown:**
`document("-ФЕ", "3000101637")` consistently returns an empty string for that same proven-to-exist
record, with company and object context both set. Exhausted without success: both argument
orders, numeric vs. string type, a third argument matching `documentExists`'s arity (empty, and
the company name), three date encodings in the second argument, two alternate number encodings
(zero-padded, type-prefixed), and `documentJournalEntries("-ФЕ", "3000101637")` as an
alternative source. Calling `document` with 0 or 1 arguments instead of 2 crashes the
connection the same way `docTypes` does, which rules out "it's a stateful cursor you read with
fewer arguments afterward" -- fewer arguments just panics, at least at these specific counts.
**The 2-argument call is confirmed not to crash and confirmed not to return anything**, which is
a materially different (and so far unexplained) finding from a simple wrong-arity guess.

**Binary-level follow-up (same live session, no further server calls):** `go tool nm` / `go tool
objdump` and radare2's Go-binary analyzer (`aang`) were all tried against the unpacked binary to
read the dispatcher's real argument-handling logic instead of guessing further. All three failed
identically -- `nm`/`objdump` can't find `runtime.pclntab` by name, and r2's binary loader
reports `lang c`, not `go`, even forced. Reading `go tool objdump`'s own source
(`cmd/internal/objfile/pe.go`) pinned the exact cause: it requires named
`runtime.pclntab`/`runtime.epclntab` **COFF symbols**, which this build's `-ldflags="-s"`
strips, with no fallback coded for PE. The pclntab bytes themselves are plainly present (proven
by the plain-string function-name extraction this whole doc is built from) -- they're just not
reachable by name.

That was worked around properly, not guessed around: a small Go program (shipped with this repo
in spirit, not in bytes -- see "Reproducing this" below) scans the raw file for `pclntab`'s own
magic number (`0xfffffff1`, current since Go 1.20 -- confirmed from the real
`internal/abi/symtab.go` shipped with a downloaded Go 1.27.3 toolchain, not from memory), applies
the same four-byte sanity check `runtime` itself uses (`parsePclnTab` in `debug/gosym`), and feeds
the found bytes into the **real, standard-library `debug/gosym` package** -- not a hand-rolled
parser. It found exactly one valid candidate, parsed into **10,982 named functions**, and a
sanity check (the globally smallest function's entry address landed exactly on `.text`'s start,
zero delta) confirmed the approach is sound.

With a real function table in hand (name -> entry address, via `gosym.Table.LookupFunc`), a
sequence of follow-on tools -- now consolidated and **checked into this repo** at
[`pclntab-tools/`](pclntab-tools/) (they were scratch-only for part of this investigation; see
that directory's README) -- answered successive questions, with one early conclusion later
**corrected** by better evidence found a few steps later. Read this in order; it is the record of
the correction, not just the end state:

1. **Is there one big dispatcher?** `main.processRequest` is a single 148,384-byte function --
   plausible as a giant RPC switch.
2. **Does it call `pmapi.Document`/`pmapi.document`/`pmapi.DocumentExists` directly?** A scan of
   every direct `CALL rel32` in **all of `.text`** targeting those three specific addresses found
   **zero** hits. (This was the wrong test to run first -- see step 5.)
3. **~~So what are `pmapi.Document`/`pmapi.document` actually for?~~** Disassembling each
   function's first ~60-100 instructions showed `pmapi.Document` comparing input against
   `"quantity"` and a string starting `"sto`, and `pmapi.document` (lowercase) against `"no"`,
   jumping into `pmapi.tabbedTextToJson`. **This was wrongly reported as "both are JSON
   field-matchers, not RPC handlers, disproving the whole naming convention."** That conclusion
   was premature: it generalized from a function's *first hundred bytes* to its entire purpose.
4. **The correction, found by then reading `pmapi.document`'s FULL body** (not just its
   prologue) with `allcalls` on its whole span: it calls `fkb33.(*Tx).Get`, `.AddValue`, `.Del`,
   `.write`, `.removeTx` -- **the embedded Firebird-family database engine**. This is real
   record-level data access, not a JSON utility. The field-name checks seen in step 3 are
   this function's *own internal mode logic* (plausibly selecting which fields of a fetched
   record to touch/return), not evidence it's unrelated to document data at all.
5. **Confirming dispatch is name-based after all:** `allcalls` on the whole of
   `main.processRequest` surfaced `runtime.mapaccess2_faststr` (12 call sites -- real
   `map[string]...` lookups by string key) and, far more directly, an inline chain of **8-byte
   literal string comparisons against the raw RPC method name itself**:
   `mov $0x7365707974636f64,%rdx` is the literal bytes of `"doctypes"`;
   `mov $0x746e656d75636f64,%rdx` right after it is the literal bytes of `"document"`. Falling
   through that second comparison (i.e. the name genuinely equals `"document"`) leads, a short
   distance later, to a direct `CALL` into `pmapi.document+0x280` -- found precisely with
   `findcallsite`, not guessed. **The original naming-convention assumption was right; step 3's
   "disproven" was the actual error**, caused by reading too little of the callee before
   concluding what it does.
6. **So why does it still return nothing?** Disassembling the instructions immediately before
   that call (`disasm` on the call site) shows an explicit gate:
   ```
   cmp $0x1,%r10 ; jbe <path-A>   -- arg count <= 1 diverts away
   cmp $0x2,%r10 ; jbe <path-B>   -- arg count <= 2 ALSO diverts away
   ...only then loads up to 6 registers (rdi,rsi,r8,r9 from an indexed struct, plus rbx,rcx
   from fixed stack slots shared with the sibling docTypes/DocFiles call sites) and calls
   pmapi.document+0x280
   ```
   **Every live call made in this investigation used exactly 2 arguments** (`type`, `number`).
   This code diverts 2-argument calls away from the real fetch logic entirely -- which is a
   complete, mechanistic explanation for every empty result seen, independent of session/company
   /object context (all of which were separately confirmed correct). `document` almost certainly
   needs a **third argument**.
7. **What's the third argument?** Tested live, same session, after re-establishing a session
   (the till's account slot had to be freed again -- see "What was actually tried" above):
   `document("-ФЕ", "3000101637", "ОБЕКТИ:СКЛАД - 1")` (object identifier as arg 3), and the same
   value in the other two plausible argument positions. **All three returned empty.** The
   arg-count-gate finding (step 6) is solid -- it's a direct read of the actual gating
   instructions, not an inference -- but the *correct* third argument is still unknown. Untried:
   reading the register-loaded struct fields (`rdi`/`rsi` from `[rdx+0x10]`/`[rdx+0x18]`, `r8`/`r9`
   from `[rdx+0x20]`/`[rdx+0x28]`) to see what *shape* of value is expected there (a third string?
   a numeric flag? a nested object?), and/or trying 4+ argument calls in case the real minimum is
   higher than 3.

**One tooling correction found along the way, independent of the above:** the first few decoded
instructions at `main.mobileRequest`'s entry looked like non-code garbage on a first pass
(`insb`, `outsl`, an `imul` with an address-size override that seemed out of place) -- this
turned out to be a **transcription error in manual hand-verification**, not a decoder bug:
printing the decoder's own `len`+raw-bytes fields directly (rather than inferring byte counts
from formatted address text -- `disasm`'s default output now always does this) showed every
instruction decoding correctly, including a genuine `0x67` prefix byte that had been miscounted
by one position by hand. **Lesson for whoever continues this: don't hand-verify byte offsets
from pretty-printed disassembly text; always check the tool's raw `len`/`bytes` fields.** The
`mobileRequest` garbage-looking region itself is still unexplained (likely genuine interleaved
data, e.g. a jump/compare table, that a purely linear disassembler walks into) -- not resolved,
and not on the critical path to the open question above.

## Transport

- `POST https://<pc>:7000/mobile`, body `JSON.stringify([methodName, ...args])`, header
  `Authorization: <token>` (the token `userLogin` returns; empty/absent for `userLogin`
  itself). Response body is a bare string -- a JSON-encoded payload, a bare error code, or
  `"error: ..."`.
- This is a **single shared account's session**, not a per-call token -- exactly like the GUI
  client. Two things cannot hold it at once (see the `-2` finding above), and the GUI app
  running on the store PC counts as one of the two.
- `disconnect()` ends the session; any read-only run against this surface should call it in
  a `finally` block so a crashed script doesn't leave the slot occupied.

## Method (and its limits)

Signal, in priority order:
1. **Explicit overrides** for the handful of names the signal below gets wrong or can't reach
   at all: the fiscal-device bridge, session/connection control, OS window chrome, and five
   names that read like getters but are **almost certainly side-effecting** (see
   "Counter-like" below).
2. **An exact camelCase word match** against a verb list (Add, Delete, Update, Change, Set,
   Rename, Save, Clone, Copy, Replace, Reset, Clear, Remove, Import, Write, Archive, Restore,
   Reindex) -- e.g. `companyChangeName` -> write (word "Change"), but `lockedDepartments`
   stays read (its first word is "locked", the adjective, not the verb "lock") and
   `deletedItems` stays read for the same reason. This is the step that catches mutations
   buried mid-name (`mountingCalendarAddDates`, `apSetCurrency`), not just ones at the start
   or end.
3. **A first-word check** (set, write, create, add, delete, save, update, rename, lock,
   unlock, reindex, restore, replace, remove, clear, reset, import, archive -> write; get, is,
   check, current, has -> read), matched on the camelCase-split first token so `lockMonth`
   (first word "lock") is write while `lockedDepartments` (first word "locked") is not.
4. **Default: read.** A bare noun or noun-phrase call (`items`, `turnover`, `ap`,
   `posReceipt`) with no recognized verb anywhere in it is assumed to be a query.

**Known blind spots, left as such rather than guessed away:**
- A name can be read-shaped and still mutate. `documentPrint()` is assumed to render only (no
  "printed" flag, no counter bump) by analogy with how LGR's own invoice Print button works --
  **unverified for PlusMinus**.
- `companySelect`, `setCurrentEmployee/Month/Object`, `setWarehouseState` change which
  company/period/warehouse the *session* is pointed at -- no business data is written, but
  calling one changes what every subsequent read in the same session returns. Listed
  separately under "Session / connection control", not under either read or write.
- Five calls are listed under "Unclear" because the heuristic genuinely has nothing to go on:
  `command`, `log`, `encodeFile`/`encodeFileServer`, `checkWeight`, `readSMRData`.

## Counter-like getters -- treat as WRITE despite the name

These read like plain lookups but the *shape* of the name (...NextNumber, ...GetNumber) is the
exact pattern LGR's own `SequenceService` uses for an atomically-incrementing counter
(`findOneAndUpdate` + `$inc`) -- fetching "the next number" is usually implemented by
**consuming** it, not by peeking. Calling one of these from a read-only probe could allocate
and burn a real document number on the live server with nothing to show for it.

| call | aliases |
|---|---|
| `getDocDateNum(e,t,n)` |  |
| `incomingNextNumber()` |  |
| `nextNumberInJournal(e)` |  |
| `payrollDocumentNextNumber(e)` |  |
| `posOrderGetNumber()` |  |
| `posReceiptGetNumber(e)` |  |
| `referenceNextNumber()` |  |

## Fiscal-device bridge -- physical hardware, legal receipts, NOT a data API

These don't touch the Firebird-family database at all; they drive whatever fiscal
printer/till PlusMinus is configured against, directly. The write half **prints real,
legally-numbered fiscal documents** under Bulgaria's Н-18 -- exactly the compliance regime
LGR's own `packages/fiscal/` implements for the other side of this migration. Never call these
from an export/automation script; included here only because they share the `/mobile` RPC
namespace with everything else.

### Write / hardware-mutating (17)

| call | aliases |
|---|---|
| `closeNonFiscalReceipt()` | `fpCloseNonFiscalReceipt` |
| `fpCancelReceipt()` |  |
| `fpClosePort()` |  |
| `fpCloseReceipt()` |  |
| `fpCloseReceiptInCash()` |  |
| `fpOpenFiscalReceipt(e,t,n,s,o,i,a)` | `fpOpenReceipt` |
| `fpOpenFiscalReceipt(e,t,n,s,o,i,a,r)` | `fpOpenReceipt` |
| `fpOpenPort()` |  |
| `fpOpenStornoReceipt(e,t,n,s,o,i,a,r,c,l,d)` |  |
| `fpPayment(e,t,n,s,o)` |  |
| `fpPrintDuplicate()` |  |
| `fpPrintText(e,t)` |  |
| `fpSellItem(e,t,n,s,o,i,a)` |  |
| `fpSetDateTime(e)` |  |
| `fpSetHeaderFooter(e,t)` |  |
| `fpSetPaymentDetails(e,t)` |  |
| `openNonFiscalReceipt()` | `fpOpenNonFiscalReceipt` |

### Read (status / report queries) (20)

| call | aliases |
|---|---|
| `fpBriefFMReportByDate(e,t)` |  |
| `fpCashInCashOut(e,t,n,s)` |  |
| `fpDailyInformation(e)` |  |
| `fpDailyReport(e)` |  |
| `fpDetailedFMReportByDate(e,t)` |  |
| `fpDiagnostics()` |  |
| `fpEJReportByDate(e,t)` |  |
| `fpEJReportByRcpNum(e,t)` |  |
| `fpFiscalNumber()` |  |
| `fpGetDateTime()` |  |
| `fpGetHeaderFooter(e)` |  |
| `fpGSDeviceInfo()` |  |
| `fpLastError()` |  |
| `fpLastReceiptNumber()` |  |
| `fpLoadSettings(e)` |  |
| `fpOperatorReport(e,t)` |  |
| `fpSerialNumber()` |  |
| `fpStatus()` |  |
| `fpSubtotal(e,t,n,s)` |  |
| `fpVersion()` |  |

## Session / connection control (13)

Changes what the *session* is connected as or pointed at, or ends/evicts a session. Not a data
mutation, but not side-effect-free either -- `disconnectAll`/`disconnectClient` end someone
else's session (possibly the till's own GUI app), and `companySelect`/`setCurrentEmployee` etc.
change what every later read in the same session sees.

| call | aliases |
|---|---|
| `changeUserByCode(e)` |  |
| `companySelect(e)` |  |
| `disconnect()` |  |
| `disconnectAll()` |  |
| `disconnectClient(e)` |  |
| `setClientServer(e,t,n)` |  |
| `setCurrentEmployee(e)` |  |
| `setCurrentMonth(e)` |  |
| `setCurrentObject(e)` |  |
| `setStarted()` |  |
| `setWarehouseState(e)` |  |
| `userLogin(e,t)` |  |
| `userLoginByCode(e)` |  |

## OS window control (6)

Client-side window chrome for the desktop app shell (minimize/maximize/position/size/close).
Harmless against a headless caller -- there is no window -- listed only for completeness.

| call | aliases |
|---|---|
| `close()` |  |
| `maximize()` |  |
| `minimize()` |  |
| `restoreWindow()` |  |
| `windowSetPos(e,t)` |  |
| `windowSetSize(e,t)` |  |

## Export (file-generating reads) (4)

Generates a file (an XML/CSV-ish government filing format, by the HR/payroll context of all
four) from data that is already there. No stored business data changes, but it is a
filesystem side effect on the server, not a pure in-memory query.

| call | aliases |
|---|---|
| `exportDayContracts(e)` |  |
| `exportSchedules(e)` |  |
| `exportSisPeriods(e)` |  |
| `exportWorkCards(e)` |  |

## Unclear -- not enough signal to call it either way (5)

| call | aliases |
|---|---|
| `checkWeight(e,t)` |  |
| `command(e,t,n)` |  |
| `encodeFile(e)` | `encodeFileServer` |
| `log(e)` |  |
| `readSMRData(e)` |  |

---

## Read-only (242)

Grouped by functional area. The "aliases" column lists other wrapper names in the client JS
that call the exact same RPC name with the same arguments.

#### Documents & files (23)

| call | aliases |
|---|---|
| `docFiles(e)` |  |
| `docTypes(e,t)` |  |
| `document(e,t)` |  |
| `documentExists(e,t,n)` |  |
| `documentJournalEntries(e,t)` |  |
| `documentPrint()` |  |
| `documentsByOrder(e)` |  |
| `documentsByOrders(e)` |  |
| `fileExists(e)` |  |
| `getHelp(e)` |  |
| `getLocale(e)` |  |
| `getPage(e)` |  |
| `getScript(e)` |  |
| `getStyle(e)` |  |
| `getSvg(e)` |  |
| `getTheme(e)` |  |
| `getThemeTemplate(e)` |  |
| `incomingNumbers()` |  |
| `makeUniqueName(e,t)` |  |
| `menu(e)` |  |
| `readFile(e)` | `readFileServer` |
| `referenceNumbers()` |  |
| `unfiledDocuments(e,t)` |  |

#### Items & stock (16)

| call | aliases |
|---|---|
| `indexGet(e,t)` |  |
| `indexGetAll(e,t)` |  |
| `indexPhone(e,t)` |  |
| `item(e,t)` |  |
| `itemBatches(e,t)` |  |
| `itemExists(e,t)` |  |
| `itemGroups(e)` |  |
| `itemOperations(e,t,n,s)` |  |
| `items(e)` |  |
| `itemsBatches(e,t)` |  |
| `itemsProperties(e,t)` |  |
| `itemStartBalance(e,t,n)` |  |
| `lastPartnerPrice(e,t,n)` |  |
| `priceRules(e)` |  |
| `recipe(e)` |  |
| `recipes()` |  |

#### Objects / warehouses (5)

| call | aliases |
|---|---|
| `getCurrentObject()` |  |
| `getWarehouseState()` |  |
| `objectOperations(e,t,n,s,o)` |  |
| `objects(e,t)` |  |
| `objectStartBalance(e,t,n,s)` |  |

#### Partners (AP -- customers & suppliers ledger) (15)

| call | aliases |
|---|---|
| `ap(e)` |  |
| `apBeginingBalance(e,t,n)` |  |
| `apCurrencies(e,t)` |  |
| `apGroups(e)` |  |
| `apHasOperations(e)` |  |
| `apIsStore(e)` |  |
| `apProperties(e)` |  |
| `apProperty(e,t)` |  |
| `apTimestamps(e)` |  |
| `apTurnover(e,t,n,s)` |  |
| `distraints(e)` |  |
| `distraintsList()` |  |
| `getPartnerByPhone(e)` |  |
| `isQuantitativeAP(e)` |  |
| `phonebook()` |  |

#### Accounting / journal / currencies (23)

| call | aliases |
|---|---|
| `accountHasOperations(e)` |  |
| `accountsBeginingBalance(e,t,n)` |  |
| `accountsTurnover(e,t,n,s)` |  |
| `amortizationDates()` |  |
| `amortizationMethod()` |  |
| `amortizations(e,t)` |  |
| `beginningBalance(e,t,n,s)` |  |
| `changeJournal(e,t,n,s)` |  |
| `chartOfAccounts(e)` |  |
| `companyAssets()` |  |
| `correctionDOO(e,t)` |  |
| `correctionZO(e,t)` |  |
| `currencyRevaluation(e,t)` |  |
| `exchangeRate(e,t,n)` |  |
| `exchangeRates(e,t)` |  |
| `journalEntries(e,t,n,s,o,i,a)` |  |
| `journalHasOperations(e)` |  |
| `journals(e)` |  |
| `openingBalance(e,t,n,s)` |  |
| `order(e,t)` |  |
| `orders(e,t,n)` |  |
| `taxAmortizations()` |  |
| `turnover(e,t,n,s,o)` |  |

#### CRM (12)

| call | aliases |
|---|---|
| `crmAccounts(e,t)` |  |
| `crmCalls(e,t)` |  |
| `crmCases(e,t)` |  |
| `crmContacts(e,t)` |  |
| `crmEmails(e,t)` |  |
| `crmEvents(e,t)` |  |
| `crmLog(e)` |  |
| `crmLogs(e,t)` |  |
| `crmObjectLinks(e,t,n)` |  |
| `crmOpportunities(e,t)` |  |
| `crmProjects(e)` |  |
| `crmTasks(e,t)` |  |

#### Construction sites / SMR / projects (11)

| call | aliases |
|---|---|
| `constructionSites()` |  |
| `getConstructionSiteFiles(e)` |  |
| `getSMR(e)` |  |
| `getSMRAdditionalExpenses(e)` |  |
| `getSMRFiles(e,t)` |  |
| `getSMRLine(e,t)` |  |
| `getSMRLines(e)` |  |
| `getSMRQuantity(e)` |  |
| `mountingCalendarGetDates(e,t)` |  |
| `mountingCalendarGetOrders(e)` |  |
| `projects()` |  |

#### POS / till (16)

| call | aliases |
|---|---|
| `posCashboxClosing(e,t,n)` |  |
| `posCashboxClosings(e,t,n,s)` |  |
| `posCashboxLastClosing(e,t)` |  |
| `posDocuments(e,t,n,s)` | `posLayaways`, `posReceipts` |
| `posLog(e)` |  |
| `posLogs(e,t)` |  |
| `posObjects()` |  |
| `posOnlySalesAllowed()` |  |
| `posReceipt(e,t)` |  |
| `posReceiptExists(e,t)` |  |
| `posReceiptIdByNumber(e,t)` |  |
| `posReceiptsByUnp(e)` |  |
| `posReversals(e,t,n)` |  |
| `posUnp(e,t)` |  |
| `reservations(e,t)` |  |
| `tables(e)` |  |

#### Vouchers / cashbox (5)

| call | aliases |
|---|---|
| `cashboxBeginingBalance(e,t)` |  |
| `cashboxEntries(e,t,n,s,o)` |  |
| `cashboxList()` |  |
| `cashboxTurnover(e,t,n)` |  |
| `vouchers(e)` |  |

#### Internal issue tracking (2)

| call | aliases |
|---|---|
| `issueComments(e,t)` |  |
| `issues(e)` |  |

#### HR / payroll / schedules (56)

| call | aliases |
|---|---|
| `absences(e,t,n,s)` |  |
| `annualAdjustmentOfIncomeTax(e,t)` |  |
| `annualLeave(e,t)` |  |
| `benefits(e,t)` |  |
| `bonuses(e)` |  |
| `bonusesPeriods()` |  |
| `brigadeDistributionCoefficients(e)` |  |
| `brigadeParticipation(e)` |  |
| `brigadeWorkCards(e,t,n)` |  |
| `businessBenefits()` |  |
| `calculateLengthOfService(e)` |  |
| `compensations(e,t)` |  |
| `compensationsForPeriod(e,t)` |  |
| `dayContracts(e,t)` |  |
| `deletedUsers()` |  |
| `departments(e)` |  |
| `employee(e,t)` |  |
| `employeeExists(e)` |  |
| `employees(e)` |  |
| `employeeSalary(e,t)` |  |
| `establishmentPlan(e)` |  |
| `establishmentPlanList()` |  |
| `hourlyPaymentSchedule(e,t)` |  |
| `isPayrollMonthLocked(e)` |  |
| `jobs()` |  |
| `officialBooksStoredByEmployer()` |  |
| `payrollDocument(e,t)` |  |
| `payrollDocumentExists(e,t)` |  |
| `payrollDocuments(e,t,n)` |  |
| `personalQualifications(e)` |  |
| `plannedHolidays(e,t)` |  |
| `previousAbsence(e,t,n,s,o)` |  |
| `registerOfAccidents()` |  |
| `registerOfEducations()` |  |
| `registerOfOfficialBooks()` |  |
| `registerOfWorkBooks()` |  |
| `registerReadjustedPersons()` |  |
| `rolePermissions(e)` |  |
| `roles()` |  |
| `rolesData()` |  |
| `salaries(e,t)` |  |
| `salaryBeforeDMS(e)` |  |
| `schedule(e,t)` |  |
| `scheduleTemplates(e)` |  |
| `shifts()` |  |
| `sirvPeriods()` |  |
| `sisPeriods(e,t)` |  |
| `tasks(e,t,n)` |  |
| `unusedHolidays(e)` |  |
| `userCode(e)` |  |
| `userData(e)` |  |
| `userPermissions(e)` |  |
| `users()` |  |
| `usersData()` |  |
| `workBooksStoredByEmployer()` |  |
| `workCards(e,t,n)` |  |

#### System / session / licensing (58)

| call | aliases |
|---|---|
| `activationId(e)` |  |
| `buildTime()` |  |
| `checkLastAccess(e)` |  |
| `clients()` |  |
| `companies()` |  |
| `companyExists(e)` |  |
| `companyHasData(e)` |  |
| `companyHasOperations(e)` |  |
| `companyInfo(e)` |  |
| `companyRead(e,t)` |  |
| `corectSerialNumber(e)` |  |
| `currencies()` |  |
| `currentCompany()` |  |
| `currentDirectory()` |  |
| `currentPath()` |  |
| `currentUser()` |  |
| `deletedItems(e)` |  |
| `expiredModules()` |  |
| `expiringModules()` | `expiredModules` |
| `getAnalyses(e)` |  |
| `getAnalysesCodes(e)` |  |
| `getAnalysis(e,t)` |  |
| `getCurrentEmployee()` |  |
| `getCurrentMonth()` |  |
| `getFixedExchangeRate(e)` |  |
| `getItemAccess(e,t)` |  |
| `getItemByCode(e)` |  |
| `getLongProcessProgress()` |  |
| `getLongProcessResult()` |  |
| `getLongProcessStatus()` |  |
| `getModules()` |  |
| `getProtocols19(e)` |  |
| `getStats()` |  |
| `getUserByCode(e)` |  |
| `getWorkDays(e,t,n,s,o,i)` |  |
| `isBankAccountDeclared(e)` |  |
| `isClientServer()` |  |
| `isMonthLocked(e)` |  |
| `isRegistered(e)` |  |
| `isYearLocked(e)` |  |
| `latestReleases()` |  |
| `lockedDepartments(e)` |  |
| `lockedMonths()` |  |
| `lockedYears()` |  |
| `moduleIsRegistered(e,t)` |  |
| `moduleRead(e,t)` |  |
| `periodIsLocked(e)` |  |
| `ping()` | `pingServer` |
| `prepareRegData(e,t,n)` |  |
| `rates()` |  |
| `ratesSettings()` |  |
| `readRegInfo()` |  |
| `readSettings()` |  |
| `readTransferFile(e)` |  |
| `registeredModules()` |  |
| `registerUrl()` |  |
| `restaurantSettings(e)` |  |
| `version()` |  |

---

## Write / mutating (235)

#### Documents & files (20)

| call | aliases |
|---|---|
| `addToUnfiled(e)` |  |
| `batchAdd(e,t,n,s)` |  |
| `batchDelete(e,t,n)` |  |
| `deleteFile(e)` | `deleteFileServer` |
| `deleteFromUnfiled(e)` |  |
| `documentAdd(e)` |  |
| `documentDelete(e,t)` |  |
| `documentUpdate(e)` |  |
| `incomingNumberAdd(e,t)` |  |
| `incomingNumberDelete(e)` |  |
| `incomingNumberUpdate(e,t)` |  |
| `linkDelete(e,t,n,s,o)` |  |
| `linksAdd(e)` |  |
| `linksUpdate(e,t)` |  |
| `menuAdd(e,t)` |  |
| `menuItemAdd(e,t,n)` |  |
| `menuItemDelete(e,t)` |  |
| `referenceNumberAdd(e,t)` |  |
| `referenceNumberDelete(e)` |  |
| `referenceNumberUpdate(e,t)` |  |

#### Items & stock (11)

| call | aliases |
|---|---|
| `indexAdd(e,t,n)` |  |
| `itemAdd(e,t,n)` |  |
| `itemDelete(e,t)` |  |
| `itemsAdd(e,t)` |  |
| `itemsUpdate(e,t)` |  |
| `itemUpdate(e,t,n)` |  |
| `priceRulesAdd(e,t)` |  |
| `priceRulesDelete(e)` |  |
| `recipeAdd(e,t)` |  |
| `recipesAdd(e)` |  |
| `reindex(e)` |  |

#### Objects / warehouses (2)

| call | aliases |
|---|---|
| `objectAdd(e)` |  |
| `objectDelete(e)` |  |

#### Partners (AP -- customers & suppliers ledger) (13)

| call | aliases |
|---|---|
| `apAdd(e)` |  |
| `apCurrenciesAdd(e,t,n)` |  |
| `apDelete(e)` |  |
| `apOpeningBalanceAdd(e,t)` |  |
| `apPropertiesAdd(e)` |  |
| `apPropertyAdd(e,t,n,s)` |  |
| `apRename(e,t)` |  |
| `apSetCurrency(e,t)` |  |
| `distraintsAdd(e,t)` |  |
| `distraintsDelete(e)` |  |
| `distraintsListAdd(e)` |  |
| `renameAP(e)` |  |
| `replaceAP(e,t,n)` |  |

#### Accounting / journal / currencies (27)

| call | aliases |
|---|---|
| `accountAdd(e,t,n,s,o,i,a,r)` |  |
| `accountDelete(e)` |  |
| `accountDetailedBalanceAdd(e,t)` |  |
| `amortizationMethodAdd(e,t)` |  |
| `amortizationsAdd(e,t)` |  |
| `amortizationsDelete(e,t)` |  |
| `companyAssetsAdd(e)` |  |
| `correctionDOOAdd(e,t,n)` |  |
| `correctionZOAdd(e,t,n)` |  |
| `currencyAdd(e,t)` |  |
| `currencyDelete(e)` |  |
| `currencyRevaluationAdd(e,t,n)` |  |
| `currencyRevaluationDelete(e,t)` |  |
| `exchangeRatesAdd(e,t)` |  |
| `exchangeRatesDelete(e)` |  |
| `journalDelete(e)` |  |
| `journalEntriesAdd(e)` |  |
| `journalEntriesDelete(e,t,n)` |  |
| `journalEntryAdd(e)` |  |
| `journalEntryDelete(e,t)` |  |
| `orderAdd(e)` |  |
| `orderDelete(e,t)` |  |
| `orderUpdate(e,t,n)` |  |
| `recalcTurnover(e,t)` |  |
| `saveRecalculatedValues(e)` |  |
| `taxAmortizationsAdd(e,t)` |  |
| `taxAmortizationsDelete(e,t)` |  |

#### CRM (27)

| call | aliases |
|---|---|
| `crmAccountAdd(e)` |  |
| `crmAccountDelete(e)` |  |
| `crmAccountUpdate(e,t)` |  |
| `crmCallAdd(e)` |  |
| `crmCallDelete(e)` |  |
| `crmCallUpdate(e,t)` |  |
| `crmCaseAdd(e)` |  |
| `crmCaseDelete(e)` |  |
| `crmCaseUpdate(e,t)` |  |
| `crmContactAdd(e)` |  |
| `crmContactDelete(e)` |  |
| `crmContactUpdate(e,t)` |  |
| `crmEmailAdd(e)` |  |
| `crmEmailDelete(e)` |  |
| `crmEmailUpdate(e,t)` |  |
| `crmEventAdd(e)` |  |
| `crmEventDelete(e)` |  |
| `crmEventUpdate(e,t)` |  |
| `crmOpportunityAdd(e)` |  |
| `crmOpportunityDelete(e)` |  |
| `crmOpportunityUpdate(e,t)` |  |
| `crmProjectAdd(e)` |  |
| `crmProjectDelete(e)` |  |
| `crmProjectUpdate(e,t)` |  |
| `crmTaskAdd(e)` |  |
| `crmTaskDelete(e)` |  |
| `crmTaskUpdate(e,t)` |  |

#### Construction sites / SMR / projects (15)

| call | aliases |
|---|---|
| `addConstructionSiteFiles(e,t)` |  |
| `addSMRAdditionalExpenses(e,t)` |  |
| `addSMRFiles(e,t,n)` |  |
| `addSMRLine(e,t)` |  |
| `addSMRLines(e,t)` |  |
| `addSMRQuantity(e,t)` |  |
| `constructionSiteAdd(e,t)` |  |
| `constructionSiteAddData(e,t)` |  |
| `constructionSiteDelete(e)` |  |
| `mountingCalendarAddDates(e)` |  |
| `mountingCalendarAddOrders(e)` |  |
| `mountingCalendarDeleteDates(e)` |  |
| `mountingCalendarDeleteOrders(e)` |  |
| `projectAdd(e)` |  |
| `projectDelete(e)` |  |

#### POS / till (10)

| call | aliases |
|---|---|
| `posLayawayAdd(e)` |  |
| `posLayawayDelete(e,t)` |  |
| `posObjectAdd(e)` |  |
| `posObjectDelete(e)` |  |
| `posReceiptAdd(e)` |  |
| `posReceiptUpdate(e)` |  |
| `posReversalAdd(e)` |  |
| `reservationsAdd(e,t,n)` |  |
| `tablesAdd(e,t)` |  |
| `tablesDelete(e)` |  |

#### Vouchers / cashbox (5)

| call | aliases |
|---|---|
| `cashboxBeginingBalanceAdd(e,t,n)` |  |
| `cashboxEntryAdd(e,t)` |  |
| `cashboxEntryDelete(e,t,n)` |  |
| `vouchersAdd(e,t)` |  |
| `vouchersDelete(e)` |  |

#### Internal issue tracking (4)

| call | aliases |
|---|---|
| `issueAdd(e,t)` |  |
| `issueCommentsAdd(e,t,n)` |  |
| `issueDelete(e,t)` |  |
| `issueStatusUpdate(e,t,n,s)` |  |

#### HR / payroll / schedules (64)

| call | aliases |
|---|---|
| `absenceAdd(e)` |  |
| `absenceDelete(e,t,n)` |  |
| `annualAdjustmentOfIncomeTaxAdd(e,t,n)` |  |
| `annualAdjustmentOfIncomeTaxDelete(e,t)` |  |
| `annualLeaveAdd(e,t,n)` |  |
| `annualLeaveDelete(e,t)` |  |
| `benefitsAdd(e,t,n)` |  |
| `bonusesAdd(e,t,n,s)` |  |
| `bonusesDelete(e,t,n)` |  |
| `brigadeDistributionCoefficientsAdd(e,t)` |  |
| `brigadeDistributionCoefficientsDelete(e)` |  |
| `brigadeParticipationAdd(e,t)` |  |
| `brigadeParticipationDelete(e)` |  |
| `brigadeWorkCardAdd(e,t,n)` |  |
| `brigadeWorkCardDelete(e,t)` |  |
| `businessBenefitsAdd(e)` |  |
| `compensationAdd(e,t,n)` |  |
| `compensationDelete(e,t)` |  |
| `dayContractsAdd(e,t,n)` |  |
| `dayContractsDelete(e,t)` |  |
| `departmentRename(e,t)` |  |
| `departmentsSave(e)` |  |
| `employeeAdd(e,t,n)` |  |
| `employeeClone(e,t)` |  |
| `employeeCopy(e)` |  |
| `employeeDelete(e)` |  |
| `employeeUpdate(e,t)` |  |
| `establishmentPlanAdd(e,t)` |  |
| `establishmentPlanDelete(e)` |  |
| `hourlyPaymentScheduleAdd(e,t,n)` |  |
| `hourlyPaymentScheduleDelete(e,t)` |  |
| `importPayrollData(e)` |  |
| `jobAdd(e)` |  |
| `lockPayrollMonth(e,t,n)` |  |
| `officialBooksStoredByEmployerAdd(e)` |  |
| `payrollDocumentAdd(e,t,n,s,o)` |  |
| `payrollDocumentDelete(e,t,n,s,o)` |  |
| `personalQualificationsAdd(e,t)` |  |
| `plannedHolidaysAdd(e,t,n)` |  |
| `registerOfAccidentsAdd(e)` |  |
| `registerOfEducationsAdd(e)` |  |
| `registerOfOfficialBooksAdd(e)` |  |
| `registerOfWorkBooksAdd(e)` |  |
| `registerReadjustedPersonsAdd(e)` |  |
| `rolePermissionsAdd(e,t,n)` |  |
| `salariesDelete(e)` |  |
| `savePayrollData(e,t)` |  |
| `scheduleAdd(e,t,n)` |  |
| `scheduleTemplatesAdd(e,t)` |  |
| `shiftsAdd(e)` |  |
| `sirvPeriodsAdd(e)` |  |
| `sisPeriodsAdd(e,t,n,s)` |  |
| `sisPeriodsDelete(e,t,n,s)` |  |
| `tasksAdd(e,t,n)` |  |
| `tasksDelete(e,t)` |  |
| `unusedHolidaysAdd(e,t)` |  |
| `userDataAdd(e,t,n,s,o,i,a,r)` |  |
| `userDelete(e,t)` |  |
| `userPermissionsAdd(e,t)` |  |
| `workBooksStoredByEmployerAdd(e)` |  |
| `workCardAdd(e,t,n)` |  |
| `workCardDelete(e,t)` |  |
| `workCardsAdd(e)` |  |
| `workCardsDelete(e,t,n)` |  |

#### System / session / licensing (37)

| call | aliases |
|---|---|
| `addAnalysis(e,t)` |  |
| `addFixedExchangeRate(e,t)` |  |
| `addProtocol19(e,t,n)` |  |
| `addWorkDays(e,t)` |  |
| `archive(e)` |  |
| `breakLongProcess()` |  |
| `companyAdd(e)` |  |
| `companyChangeName(e,t)` |  |
| `companyChangeType(e,t)` |  |
| `companyDelete(e)` |  |
| `companySave(e,t)` |  |
| `companyUpdate(e)` |  |
| `createRegInfoForModule(e,t)` |  |
| `deleteAnalysis(e,t)` |  |
| `deleteOldOperations(e,t,n)` |  |
| `docFileAdd(e,t,n,s,o)` |  |
| `docFileDelete(e,t)` |  |
| `lockMonth(e)` |  |
| `lockYear(e)` |  |
| `moduleSave(e,t)` |  |
| `ratesAdd(e)` |  |
| `ratesDelete()` |  |
| `ratesSettingsAdd(e)` |  |
| `renameEmployee(e,t)` |  |
| `resetStats()` |  |
| `restaurantSettingsAdd(e,t)` |  |
| `restore(e,t,n,s)` |  |
| `roleDelete(e)` |  |
| `sendMail(e,t,n)` |  |
| `sendMailWithSendgrid(e)` |  |
| `setBankAccountDeclared(e,t)` |  |
| `setSettings(e)` |  |
| `unlockMonth(e)` |  |
| `unlockYear(e)` |  |
| `update(e,t)` |  |
| `writeSettings(e)` |  |
| `writeTransferFile(e,t)` |  |

---

## Appendix: the other, smaller admin API (/server, not counted above)

The admin console (the page at `https://<pc>:7000/` after login -- archive/restore buttons,
client list, licensing) rides a **separate** endpoint, `POST /server`, authorized with a
fixed token the page itself embeds (`<input id=token ... value=...>`), not a `userLogin`
session. It is a much smaller surface (~20 calls) and was **not** part of the "all 554" count
-- listed here only because it lives on the same server and this doc would be misleading if it
implied the two were the same thing.

| call | read or write | notes |
|---|---|---|
| `version()` | read | |
| `buildTime()` | read | |
| `clients()` | read | lists connected client names |
| `readSettings()` | read | |
| `getLongProcessStatus()` | read | polled during archive/restore |
| `getLongProcessProgress()` | read | |
| `hardwareId()` | read | tried live -- see memory plusminus-export-over-roomler |
| `registeredModules()` | read | license info |
| `moduleIsRegistered(e,t)` | read | |
| `isRegistered(e)` | read | |
| `expiringModules()` / `expiredModules()` | read | same underlying call, aliased |
| `activationId(e)` | read | licensing helper, computed not stored |
| `corectSerialNumber(e)` | read | validates a serial format |
| `prepareRegData(e,t,n)` | read | builds a payload, does not send it |
| `writeSettings(e)` | **write** | autoarchive time / port / timeout |
| `archive(e)` | **write** | triggers a full .arz backup into the archive folder |
| `restore(e)` (HTTP POST /restore, multipart) | **write, HIGHEST RISK** | replaces the ENTIRE live database from an uploaded .arz |
| `disconnectClient(e)` | **write** | evicts one connected client |
| `disconnectAll()` | **write** | evicts every connected client |
| `createRegInfoForModule(e,t)` / `saveRegInfo(e)` | **write** | persists a licensing activation |

---

## If this is actually pursued: safety notes before writing automation against it

1. **There is one account slot.** Confirm with the operator before connecting -- a failed
   login under the admin account with `-2` means the till's own GUI is using it, exactly the
   same "someone may be using the PC" check [export-gui.md](export-gui.md) already asks for
   over remote desktop, just surfaced as an API error code instead of a live cursor.
2. **Verify each call's read/write classification against a non-production copy before
   trusting it**, starting with the ones this doc flags as uncertain (counter-like, unclear,
   export, session). The heuristic is naming convention only; nothing here was round-tripped
   against a real response.
3. **Never call anything in the fiscal-device or /restore sections from an export script.**
   Both are one bad argument away from printing a real legal receipt or replacing the entire
   live database.
4. If a read-only pull is proven safe, it still can't replace [[pull-plusminus-docs]] outright
   -- that skill's `check-snapshot.ts` zero-quantity-row check and `pull-manifest.txt`
   SHA-256 verification would need an equivalent on the API path before either could be
   trusted as the storeAvailability/invoicem source of truth for the regal-pz migration.
