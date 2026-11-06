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
  --books <ACC_DOCS_ROOT>/books/<day> --api <url> --org <orgId> \
  --version 202601=20260211_084833 --months <every FILED month, comma-separated>                      # then --execute / --verify

# VAT files, as before
bun run scripts/import-vat-files.ts --org regal-acc --dir "$ACC_FILINGS_DIR/nap/vat"
```

- `--books` replaces `--chart/--analytics/--opening/--opening-analytics/--journal`, and mixing them is refused.
- `--root-account ROOT=ACCT` is the archive's counterpart of `--opening-analytics <trial balance>=<account>`: the archive stores
  an analytic's opening per item, not per account.
- Archive sheet rows carry the ЕГН, so `import-payroll.ts` joins them to the declarations by ЕГН. A GUI sheet has none, so it
  joins by surname and initials.
- ⚠ `--version 202601=20260211_084833`: the accountant filed January 2026's OLDER version (FR-25 §12). Without the pin the
  importer takes the newest, and a re-import quietly turns that month back into the version nobody filed.
- ⚠ `--months` must leave out a month whose declaration is not filed yet. `pull-filings.ts` copies the files as soon as the
  accountant writes them: 202610 was on disk from 11-03, and is due on 11-25. People and contracts still read every month on disk
  (on 11-05 that changed no contract: they were folded with and without 202610).
- `import-payroll.ts` takes `LGR_TOKEN` only, not `LGR_USERNAME`/`LGR_PASSWORD`.

**regal-acc switched from the GUI exports to the archive on 2026-11-05, on the owner's word.** A re-import of the same day now
reports everything `unchanged`. A later day reports only what was booked or corrected since.

The books, both years. Each dry run changed exactly the documents the export had damaged: planning both files with the server's
own `planMonth` predicted the counts of every month.

| year | entries | changed | replaced (new = gone) | opening |
|---|---|---|---|---|
| 2025 | 27,442 | 272 | 146 | names corrected; 26 lines moved by under half a cent |
| 2026 | 22,151 | 126 | 41 | names corrected; 1 line moved by under half a cent; continuity 66/66 |

- The chart (251) and the analytics (10,340) were unchanged, finish changed 0 accounts, and a dry rerun of each year is unchanged.
- ⚠ The opening's sub-cent moves are not damage. The printed trial balance rounds each line to the cent, and the archive carries
  the database's value. No account total moved.
- ⚠ **After the switch, the gate against GUI exports reports the export's damage as differences.** `compare-accounting-books.ts`
  compares with the PRINTED files. The journal export's turnovers per analytic were equal while the books were that export; now
  they differ on every name the export broke (2025: 12, 2026: 5), and so do the analytic trial balances (10 and 4). Moved onto its
  real name, each of those rows is equal, but one: a 2025 supplier whose closing is 0.62 of a cent off the print, from its
  opening's sub-cent value. The main book, the turnovers per account and the 2026 trial balance stay equal.
- What the GUI files left behind was deactivated on 2026-11-05, on the owner's word: 39 analytics and 14 contacts whose names
  hold U+FFFD (`scripts/deactivate-books-leftovers.ts`). The "20" first counted were only the booked paths; the broken roots and
  damaged list rows are the rest. One broken letter is two U+FFFD, and each row had exactly one active twin under the real name.

Payroll, the same day:
- The GUI „Ведомост" exports held about 8 rows a month against 16–18 declared people (202509: 1 of 17). With `--books`, every
  declared person has their lines, identical wherever both sources have the person-month. The exception is December 2025, whose
  GUI sheet was exported before the month was final.
- 39 months were replaced and 5 left unchanged, and the dry rerun is unchanged. `--verify`: обр. 1 44/44, обр. 6 42/42,
  contributions 42/42, people 44/44.
- 27 contracts were updated from the 11-05 personnel data: the same 27 that a GUI re-import updates. The archive also gives 12
  of them a class percentage that no GUI export carries.
- 202206 and 202207 (one person each) have a sheet row only in the GUI's export, so those two months were left as they were.

## Nightly run (unattended, books only)

From 2026-11-05 until go-live, on the owner's word, the books import runs by itself on this PC. Payroll and VAT stay runs by
hand (above): which months are filed is a person's to say.

```bash
bun .claude/skills/pull-plusminus-books/nightly.ts               # fetch → pull-books --no-payroll → each year --execute → dry rerun
bun .claude/skills/pull-plusminus-books/nightly.ts --dry         # the same, writing nothing in LGR and mailing nothing
bun .claude/skills/pull-plusminus-books/nightly.ts --local       # the newest archive already fetched: a re-run without the PC
bun .claude/skills/pull-plusminus-books/nightly.ts --check-mail  # SendGrid sandbox: proves the alert channel, delivers nothing
```

- **It mails only on a change or a failure**: counts per year, then the documents that differ from the last import, a line
  each: date, type and number, and `new`, `changed` (with what: operations, total, amounts, accounts, analytics, notes),
  `moved` (to another customer or supplier) or `gone`. Never a name or an amount. A mail carries the first 60 lines, and
  `books/<day>/changes-<sha>.txt` has them all. The same failure is mailed once a day. The PC is off at night and at
  weekends, so no answer is quiet, until 72 hours of it, which is a failure.
- The documents of the last import are kept by the importer's own key in `books/nightly-documents.json.gz` (about 2.6 MB),
  which is what the next list compares with. ⚠ The books PC writes the day's archive again, under the same name, at each
  session close, and `fetch-archive.ts` replaces the earlier copy. On 2026-11-06 the 13:00 import mailed „64 change(s)" from
  a second `20261105.arz`, and the first copy it differed from was already gone, so nobody could say which documents those
  were. Without that file, or the last import's own day folder, the mail says the documents are not listed.
- It imports each archive once: `nightly-state.json` beside the day folders remembers the last one by SHA, and `nightly.log`
  has a line a run. After each year's import, a dry rerun must report everything unchanged, or the run fails.
- 2025 and 2026 only (`BOOKS_NIGHTLY_YEARS`). A later year in the archive is reported, never imported unattended: its first
  import opens the year. Import it by hand once, then add it.
- The day folders it writes hold no payroll (`--no-payroll`). Before a payroll run, run `pull-books.ts` for that day without it.
- Nothing prunes the day folders (about 45 MB each, mostly the two journals); `fetch-archive.ts` keeps the last 14 archives. A
  day folder is derived: delete old ones by hand, and `pull-books.ts` makes any of them again while its archive is kept.
- ⚠ The docs root is a WSL share, and it lives only while the distro runs. WSL stops an idle distro within seconds, and a read
  that lands while it starts or stops fails ("Invalid request code", `ECANCELED`). The run holds the distro up with a `sleep`
  inside it. On 2026-11-05 a job inside WSL ran the VM out of memory, and the share failed in the middle of a test run.
- ⚠ A STUCK distro does not fail a read, it hangs it. The same day, from 22:52 to 23:00 UTC, every `wsl -d` answered
  `Wsl/Service/E_UNEXPECTED` and an `ls` of the share sat there for minutes. So the run first asks a child process to list the
  root (10 s a try, 90 s in all) and kills it when it does not answer. With no answer, nothing runs and it exits 1.
- The state cannot say the share is down, because it lives on the share. Since when the root has not answered is kept on the PC,
  in `%LOCALAPPDATA%\lgr-books-nightly\docs-root.json`. After `BOOKS_NIGHTLY_DOWN_HOURS` (6) it is mailed, then once a day, and
  the first run that reads the root again says it is back (only when the outage was mailed).

**The account.** `books-sync` in regal-acc, role member, with one permission set, „Service: books import": `accounting.import`
and no area.
- Every other route answers 403. Checked: contacts, accounts, journal, payroll employees and contracts, VAT.
- Made with `scripts/seed-user.ts --role member --permissions accounting.import --set-name "Service: books import"`.
- Its password is only in the main checkout's gitignored `.secrets/lgr-books-sync.env`, beside `BOOKS_NIGHTLY_MAIL_TO`.
- To revoke it, deactivate the user in regal-acc's users, then remove the task.

**The schedule.** Task Scheduler's „LGR books nightly" runs every two hours from 07:00 to 23:00, as goran, only while signed in,
with no window (`run-hidden.vbs`). It runs from a worktree pinned at a reviewed commit, `C:\dev\gjovanov\lgr-books-nightly`,
detached.
- Register it, or remove it, with `register-nightly.ps1 -Checkout <worktree>` or `register-nightly.ps1 -Remove`, run as
  `powershell -NoProfile -ExecutionPolicy Bypass -File …`: Windows runs no scripts by default, and a plain `-File` is refused.
- Move the pin deliberately, after a deploy that changes the importers. A client ahead of the server it talks to fails.

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
