---
name: pull-plusminus-books
description: Export the accountant's books and payroll (Regal's real ledger, kept in a local-mode PlusMinus on the books PC) without the GUI — fetch the PC's nightly database archive, read the journal, chart, analytics, openings, personnel and salary sheets straight out of it, plus the filed VAT and payroll files, into a day folder the FR-25 importers take with --books. Use for the daily accounting/payroll sync before go-live, to re-export a day after the accountant corrects something, to re-import a year into regal-acc, or to prove the archive against GUI exports of the same day.
---

# pull-plusminus-books

The accountant's PlusMinus runs in **local mode**: no server, no API (memory `lgr-accounting-books-source`). What it does have is
an **automatic archive** written each time the day's session closes: `<install>\archive\<yyyymmdd>.arz`, ~50 MB, one per day
back to April 2023. That archive is the whole database, in a simple format, and this skill reads it directly:

```
fetch-archive.ts   books PC ──roomler ssh──▶ <ACC_DOCS_ROOT>/archives/<yyyymmdd>.arz.sealed      (sealed on arrival)
pull-books.ts      archive ─────────────────▶ <ACC_DOCS_ROOT>/books/<yyyymmdd>/                  (journal, chart, analytics,
                                                                                                  openings; payroll sealed)
pull-filings.ts    books PC ──roomler ssh──▶ $ACC_FILINGS_DIR, $ACC_FILINGS_SEALED_DIR           (VAT and payroll filings)
verify-exports.ts  archive vs GUI exports of the same day: PASS/FAIL per artifact
```

No GUI, no vendor server, no admin rights, nothing written on the books PC.

## Store identifiers

Nothing that names the PC is in this repo. Everything comes from the gitignored `.secrets/plusminus-stores.env` (see
`pull-plusminus-api/SKILL.md`, "Store identifiers"):

- `ACC_ROOMLER_AGENT`: the books PC's agent id;
- `ACC_PM_ROOT`: the Regal install folder on it;
- `ACC_DOCS_ROOT`: the local root for everything here;
- `ACC_FILINGS_DIR`, `ACC_FILINGS_SEALED_DIR`: where `pull-filings.ts` writes. They point at the folders the FR-25 pulls have
  always used. Unset, they default to `$ACC_DOCS_ROOT/filings{,-sealed}`.

The seal keys are the backup seal's:
- `BACKUP_ENCRYPTION_PUBLIC_KEY`, from the main checkout's `.env`;
- the private half at `.secrets/lgr-backup-seal.key`, or `BACKUP_SEAL_KEY_FILE`, used only to open things in memory.

## Daily run

```bash
bun .claude/skills/pull-plusminus-books/fetch-archive.ts --list   # newest archives, and whether PlusMinus is open there
bun .claude/skills/pull-plusminus-books/fetch-archive.ts          # the newest COMPLETE one (or --name 20261105.arz); keeps 14
bun .claude/skills/pull-plusminus-books/pull-books.ts             # newest fetched archive -> books/<day>/ (--years 2025,2026)
bun .claude/skills/pull-plusminus-books/pull-filings.ts           # VAT + payroll filings, only what changed (--list first)
bun .claude/skills/pull-plusminus-books/verify-exports.ts --archive … --exports … [--sealed …]   # only when a same-day GUI export exists
```

- The archive appears when the accountant closes PlusMinus, usually in the evening. A day with no session has no archive.
- An archive younger than 3 minutes is skipped (`--min-age-min`): it may still be being written.
- Every output carries a manifest (`new` / `same` / `REPLACED`). A re-run over the same archive writes nothing (proven: 26/26 `same`).
- `fetch-archive.ts` carries the whole 50 MB in ONE `roomler ssh` call: 80 s, SHA-256 checked on both ends, gzip CRC checked before
  sealing. `roomler exec` would not do: it caps a call's whole output near 256 KB.
- ⚠ The archive is NAMED after the day it was written, and it holds what was booked up to that moment. `20261105.arz`, written at
  01:08 on 11-05, holds the books to 11-04. `meta.json`'s `span.last` is the last date that has an operation.

## Import

The day folder feeds the existing importers, which keep every guard they have for GUI files. Both dry run by default.

```bash
# accounting, one year at a time (each year in the currency it was booked in)
LGR_TOKEN=… bun run scripts/import-accounting-books.ts --org regal-acc --books <ACC_DOCS_ROOT>/books/<day> --year 2026 \
  --root-account СТОКИ=304 --root-account КЛИЕНТИ=411 --root-account ДОСТАВЧИЦИ=401 --finish        # then --execute

# payroll: declarations from the sealed filings, personnel and salary sheets from the archive
LGR_TOKEN=… bun scripts/import-payroll.ts --root "$ACC_FILINGS_SEALED_DIR" --identity .secrets/lgr-backup-seal.key \
  --books <ACC_DOCS_ROOT>/books/<day> --api <url> --org <orgId>                                       # then --execute / --verify

# VAT files, as before
bun run scripts/import-vat-files.ts --org regal-acc --dir "$ACC_FILINGS_DIR/nap/vat"
```

- `--books` replaces `--chart/--analytics/--opening/--opening-analytics/--journal`, and mixing them is refused.
- `--root-account ROOT=ACCT` is the archive's counterpart of `--opening-analytics <trial balance>=<account>`: the archive stores
  an analytic's opening per item, not per account.
- Archive sheet rows carry the ЕГН, so `import-payroll.ts` joins them to the declarations by ЕГН. A GUI sheet has none, so it
  joins by surname and initials.

⚠ **The first re-import from the archive will report changes.** regal-acc was imported from the 11-05 GUI exports, which carry
the export's own damage (below). The archive holds the undamaged text, so the documents concerned come back `changed`.

Dry run of 2026 against prod regal-acc (2026-11-05):

| step | result |
|---|---|
| chart | 251 unchanged |
| analytics | 10,340 unchanged |
| opening | `changed`: the archive spells the analytic names right. Balanced, continuity 66/66 |
| journal | 22,151 entries, all balanced. 21,984 unchanged (exactly the documents byte-equal to the export); 126 changed, 41 replaced |
| finish | 0 accounts changed |

The analytics that the broken names created in LGR stay behind, empty: look at them before `--execute`.

⚠ **Payroll: the archive covers every declared person, the GUI sheets did not.** The GUI „Ведомост" exports hold about 8 rows a
month against 16–18 declared people: 202509 had 1 of 17, 202601 had 4 of 16. So most imported months carry salary lines for a
few people only. With `--books`, every declared person gets their lines, joined by ЕГН, and they are identical wherever both
sources have the person-month. The one exception is the December 2025 sheet, exported before the month was final.

The dry run therefore reports `replace` on most months. That is an improvement, but it changes prod payroll data: run
`--execute` only on the owner's word, and then `--verify` (the declarations re-emit unchanged, since lines do not enter them).

## What is proven (2026-11-05, archive 20261105 vs the GUI exports taken from the same state an hour earlier)

`verify-exports.ts --archive … --exports … --sealed …` checks this, and passes:

| artifact | result |
|---|---|
| journal 2025 (BGN) | 26,475 documents, 132,567 operations, 1 without header: all equal but the export's damage |
| journal 2026 (EUR) | 21,408 documents, 110,250 operations: all equal but the export's damage |
| chart 2025, 2026 | 253 accounts each, in order, openings included (largest difference 5.8e-11) |
| analytics | 16 roots, item for item (10,366 rows) |
| analytic openings | 6 trial balances (СТОКИ, КЛИЕНТИ, ДОСТАВЧИЦИ × 2 years): all equal |
| personnel | 361 rows of the 11-05 exports, 14 fields, 0 unequal (a re-hired person = one row per engagement) |
| salary sheets | 4,930 of 4,943 mapped cells over 45 months; every miss is in one sheet, 202512, exported on 19 Dec before the month was final |

**The export's damage**, each checked value by value:
- it cuts text at 120 characters;
- it breaks some Cyrillic letters into U+FFFD. The "31 broken analytic names" sent to the accountant on 11-05 are this: the
  database spells them right;
- it rounds numbers to 10 decimals. The reader rounds the same way: the database keeps float noise such as `837.5699999999999`.

Re-run the proof whenever a same-day pair exists: after a PlusMinus update, or when a new document type shows up. It compares
only exports stamped on the archive's day or the day before (`--since`), because an older export shows the database as it was.

## Personal data

The archive holds every employee's ЕГН, address and pay. Rules:

- The archive is sealed on arrival. The plaintext lives only in memory.
- Payroll outputs are sealed: `payroll-`, `personnel-` and `salary-sheets-<day>.json.sealed`.
- The books outputs never contain the ПЕРСОНАЛ analytic root, nor an account's АНАЛИТ index (which names employees under 421/425).
- Tools print counts only. Never print a name, an ЕГН or a per-person amount: the output lands in transcripts. To look at
  payroll, open it in memory, print shapes (`9`/`Я`/`A`) or counts.
- The books PC also holds other companies' installs: only `ACC_PM_ROOT` is ever listed, and a dump with two companies is refused.

## Where things are in the archive (for the next reader)

`packages/services/src/biz/accounting-books/plusminus-archive.ts` has the format.
- Each record is `[tag][depth][u32 LE length][CP1251 bytes]`, a pre-order walk of the key tree, gzipped. Tag `0x28` = float64.
- `ФИРМИ\<company>\…`:
  - `ОПЕРАЦИИ\<yyyymmdd>\<seq>`: a header record is followed by its operations (`ДЕБИТ`, `КРЕДИТ`, `АНАЛДЕБ`, `АНАЛКРЕ`, `СУМА`…).
  - `СМЕТКОПЛАН\СМЕТКИ\<code>`: `ИМЕ`, plus `САЛДА И ОБОРОТИ\НАЧАЛНИ\<year>\НАЧАЛНО САЛДО\{ДЕБИТ|КРЕДИТ}`.
  - `СМЕТКОПЛАН\АНАЛИТИЧНИ ПРИЗНАЦИ\<root>\…`: nested analytics with `ПАРАМЕТРИ`, openings and `ВАЛУТИ` (foreign currency).
  - `ПАРАМЕТРИ\Булстат`: the company's ЕИК.
  - `ТРЗ\ПЕРСОНАЛ\<person>\{ПАРАМЕТРИ, ЗАПЛАТИ\<YYYYMM>\{ДНИ,СУМИ}\<code>, ОТСЪСТВИЯ}`. The code ↔ sheet-label map is
    `scripts/lib/payroll-archive.ts` `SHEET_LABELS`. Incapacity days (`Дни във временна неработоспособност`) are not mapped:
    no code fits every month, and nothing reads them.
- Not exported, because they are derived: trial balances, main book. LGR computes them from what is imported, and
  `compare-accounting-books.ts` remains the gate against the accountant's own.

## Why not a local pmserver (investigated 2026-11-05, so nobody repeats it)

The first idea was to restore the archive into the vendor's `pmserver.exe` on this PC and use its API. It works mechanically: an
archive placed as `data\plusmin.inz` becomes the database on first start. It was rejected for daily use on this PC because:

- The server refuses to run interactively (a build flag), so it must be a Windows service.
- It must run as LocalSystem: the restore writes a RELATIVE `process.tmp`, which lands in `C:\Windows\System32`, the
  working directory of every service.
- It listens on every interface, on the API port and on a plain-HTTP copy of `/mobile` at 7007. Neither address is configurable.
- On this PC the Windows Firewall is off. Service-hardening rules are not enforced while it is off. Roomler installs hard
  permits (`CLEAR_ACTION_RIGHT`) for all overlay traffic in the two highest-weight WFP sublayers. And Wi-Fi has public IPv6.
  So the books and payroll would be reachable from the LAN, the overlay and possibly the internet while it ran, by a SYSTEM
  process.

The archive is read in 11 s with none of that, and the numbers are proven above. The investigation's tool fix is in
`pull-plusminus-docs/pclntab-tools/goann.mjs`: it now calibrates an externally linked build's `.text` offset itself.
