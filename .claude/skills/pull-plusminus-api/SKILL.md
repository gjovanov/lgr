---
name: pull-plusminus-api
description: Pull a PlusMinus day or date range directly over its /mobile RPC API — invoices, stock receipts, transfers, write-offs (per org) and the full stock snapshot — as structured JSON, parametrized by org, date range and warehouse. An alternative data path to pull-plusminus-docs' GUI export, proven live 2026-10-27 against regal-pz. Use when the user wants a fast, OCR-free extraction of a day's PlusMinus documents for an already-configured org, or wants to add a new org to the config.
---

# pull-plusminus-api

Calls PlusMinus's own `/mobile` RPC surface directly — the same calls its desktop/mobile client
makes — instead of exporting PDFs/xlsx through the GUI and OCR'ing them. One call shape, proven
against regal-pz: `documents()` lists a period's headers, `document(date\num)` fetches one in
full, `items()` returns the whole stock snapshot. See
[`../pull-plusminus-docs/plusminus-mobile-api-reference.md`](../pull-plusminus-docs/plusminus-mobile-api-reference.md)
and its `pclntab-tools/handover-api-investigation.md` for how these call shapes were found
(reading the vendor's own embedded client JS — not disassembly, not guessing).

**This is the raw-extraction layer only.** Nothing here writes into LGR; no import skill reads
this JSON yet. It's a separate decision whether/how `import-sales-invoices` etc. should consume
it instead of OCR'd PDFs.

## Everything is per-org, nothing is shared by assumption

`orgs.ts` holds one config per org: `baseUrl`, `company`, `warehouse`, `credsPath`, `docsRoot`,
and a `families` map (doc-type codes → output prefix); the first five of those come from the
gitignored `.secrets/plusminus-stores.env` (next section). **Never copy a working org's config to a
new one and assume it mostly applies.** Proven live 2026-10-27, both ways:

- **Same-looking company ≠ same server.** regal-pz and regal-sf's PlusMinus both show the same
  company name (and EIK), but are genuinely separate `pmserver.exe` installs — an unfiltered
  `documents()` listing against regal-pz's server returns zero of regal-sf's known document
  numbers across two full days, and the one object name they coincidentally share
  (`ОБЕКТИ:СКЛАД`) is confirmed empty (0 products via `items()`) on regal-pz's server. It's an
  unused placeholder there, not a bridge to the other store.
- **A type code's meaning is per-org.** regal-sf's till/sales register comes back as type `СР` —
  the *exact* code regal-pz uses for store-to-store stock transfers. Mapping regal-sf's `СР` into
  a `sklrazp`-named family would silently relabel sales as transfers. Always read a NEW org's
  `documents()` output with no `doc` filter first, and look at `header.doc` + `header.comment`
  per entry, before writing its `families` map — that is literally how the regal-sf collision
  above was caught, not guessed.

`getOrg(id)` refuses (doesn't guess) when a required variable is missing, naming it.
`baseUrl` may legitimately be `null` for an org reachable only through a tunnel — see "Orgs
reachable only through a tunnel" below — checked separately, in `pull-api.ts`, once `--base-url`
has had a chance to supply it.

## Store identifiers (kept out of this public repo)

Nothing that names a store's machines lives in the repo. `stores-env.ts` reads the gitignored
`.secrets/plusminus-stores.env` (shell-sourceable `NAME=value` lines, values with spaces
single-quoted). A real environment variable of the same name wins over the file, and
`PLUSMINUS_STORES_ENV` points at another file (a git worktree has no `.secrets/` of its own: the
main checkout's file is found next to the git common dir).

| variable | what it holds |
|---|---|
| `PZ_PM_BASE_URL` | regal-pz's PlusMinus server, directly reachable over the Roomler overlay |
| `PZ_PM_COMPANY`, `SF_PM_COMPANY` | the company string exactly as `companies()` spells it, invisible padding included |
| `PZ_DOCS_ROOT`, `SF_DOCS_ROOT` | the local day folders (`<root>/<day>/api/`) |
| `PM_CREDS`, `PZ_PM_CREDS`, `SF_PM_CREDS` | paths of the two-line `un:` / `pw:` files: the default, then per org |
| `PZ_STORE_PC`, `PZ_ROOMLER_AGENT`, `PZ_PM_CLIENT_ROOT` | the regal-pz store PC: display name, Roomler agent id, PlusMinus client folder on it |
| `SF_STORE_PC`, `SF_ROOMLER_AGENT`, `SF_PM_REMOTE`, `SF_PM_CLIENT_ROOT` | the same for regal-sf; its server is a LAN address (`host:port`) behind that PC |

Adding an org = a `DEFS` entry in `orgs.ts` plus its `<PREFIX>_…` lines in that file. The
credentials files themselves hold secrets: keep them under `.secrets/` or outside the checkout.

## Adding a new org

1. Get a server address + a `un`/`pw` credentials file (two lines, `un: ...` and `pw: ...`, never
   committed) for that install specifically — don't assume another org's server or credentials
   extend to it. A private LAN address (`192.168.x.x`) won't be reachable directly the way
   regal-pz's overlay one is — see the tunnel section below before concluding an org is
   unreachable.
2. One minimal **read-only** live check, same discipline as below: `companies()` (confirm the
   exact company string — it may have invisible padding, as regal-pz's does: several internal
   spaces where one would be expected), `objects()` (confirm the real warehouse string — and check
   `items()` on each candidate before trusting one; an org can have an empty, coincidentally-named
   placeholder object, proven for both regal-pz and regal-sf), then
   `documents(day, day, '', 'forward', '{"get":"h"}', 'false')` with **no type filter**, and read
   every `header.doc` **as JSON text** that comes back — that is the org's real family map, not a
   guess, and not a reading off a screenshot either (a type code misread this way, twice, cost
   real time adding regal-sf — see `export-gui.md`'s regal-sf section for exactly how).
3. Fill in `orgs.ts`, run `pull-api.ts` for one real day, and sanity-check counts/ranges against
   whatever manual record exists for that day (journal screen, memory notes, an existing GUI
   pull) before trusting it unattended.

## Orgs reachable only through a tunnel

Not every org's server is directly reachable. regal-sf's is a private LAN address behind its till
PC, confirmed unreachable from outside that network. The fix is a `roomler forward` (not
`ssh`/`exec` — no bootstrapping needed on the target device for this), then `--base-url`:

```bash
set -a && source .secrets/plusminus-stores.env && set +a
roomler forward --agent "$SF_ROOMLER_AGENT" --local 17000 --remote "$SF_PM_REMOTE" --daemon
bun .claude/skills/pull-plusminus-api/pull-api.ts --org regal-sf --base-url https://127.0.0.1:17000 --from 2026-10-27
roomler kill fl-N   # fl-N from `roomler flows` — tear it down when done
```

The local port isn't reserved — pick any free one. The forward can drop on its own mid-session
(seen once live, no PlusMinus-side cause): a sudden `ECONNREFUSED` on a call that was working
means re-run `roomler forward` and retry, not that the org's config is wrong. Leave other flows
in `roomler flows` alone — this machine may have unrelated forwards already running.

## A dedicated account per store

PlusMinus allows ONE session per account name, so a tool that signs in as the shared admin account
collides with the store's own admin GUI (`userLogin` → `-2`, exit 3) and has to wait for the evening.
Each store's tools therefore sign in as their own account, `lgr-api`, created once with
`create-api-user.ts`; the path of its credentials file is that org's `<PREFIX>_PM_CREDS` in
`.secrets/plusminus-stores.env`. regal-pz has one (2026-11-02): a pull as `lgr-api` ran while the
admin account's session was held, and the receipts it fetched were byte-identical to the admin
account's. regal-sf has one too (2026-11-02): its documents pulled as `lgr-api` are byte-identical
to the admin account's across every family, and the daily email runs on it unchanged, because
`getOrg(...).credsPath` reads `SF_PM_CREDS` (an org without that variable falls back to `PM_CREDS`).

```bash
# dry run (the default): checks the server and the name, prints the call, writes nothing
bun .claude/skills/pull-plusminus-api/create-api-user.ts --org regal-pz --role "<an existing role>" --creds-out .secrets/plusminus-api.txt
# then the same line with --execute
```

What it relies on, and what it does not give you:

- `userDataAdd(user, role, password, code, name, job, signature, actingUser)`. The meaning of the
  eight strings was read from the server's own machine code, for ONE build (`buildTime()` =
  `20260805:101606`); the tool refuses any other build unless `--allow-other-build`, so re-read
  `pmapi.UserDataAdd` (`pclntab-tools/`) before trusting it there. It REPLACES the user named in
  argument 1 and stores only non-empty values: the name must be new (the tool checks), and an
  empty code means the account cannot sign in by code. See the reference doc for the table.
- The account carries no permission record, like the admin's, so it is **not read-only**. The admin
  console (`/login` → `/server`) also accepts any account's login, so whoever holds this password
  can reach `archive`, `restore` and `disconnectClient`. The tool says so after every run. Keep the
  file under `.secrets/`.
- Pulling as it needs no `/server` rights. The puller's `clients()` pre-check still works with it,
  and is skipped, with a note, if a store's console ever refuses the login.
- `--role` must be a label the server knows. `roles()` lists them where a server has a role table.
  regal-sf keeps none: `roles()` answers with an empty body and the labels exist only on the accounts,
  so the tool then accepts the labels its accounts already carry, and prints them when yours is not one.

The tool needs the admin account's slot free, and never frees it. If the owner says the PC is free and
the session in the way has to be ended by hand, first find out whose it is, because `clients` gives names only:

- The GUI writes `login.json` (`user`, `server`, `port`, `mode`; no password) and `clients.txt` into its
  own folder at each sign-in, so their content and timestamp say which account that PC signed in as, and when.
- The renderer process (`--type=renderer`) gaining no CPU over several minutes says nobody is using it.
- The GUI's TCP connections to the server are NOT evidence: on regal-sf the count stayed the same after
  `disconnectClient`. Nor does the GUI react until someone next uses it.
- regal-sf's server is not on its till PC, so `C:pmserverlogs` cannot be read there. What you can prove is
  the client side only; say so.

## Running it

```bash
bun .claude/skills/pull-plusminus-api/pull-api.ts --org regal-pz --from 2026-10-26 [--to 2026-10-27]
```

- `--from`/`--to` (default `--to = --from`): PlusMinus's `documents()` takes a period natively —
  a range is one call, not a loop per day.
- `--warehouse NAME` overrides the org's configured warehouse (for the stock snapshot only;
  `documents()` is NOT scoped by warehouse — see the reference doc's "Field verification" section).
- `--base-url URL` overrides the org's configured server — required for an org whose `orgs.ts`
  entry has `baseUrl: null` (reachable only through a tunnel; see above).
- `--families a,b,c` restricts to specific families (by `orgs.ts` prefix) instead of pulling all.
- `--no-snapshot` skips the (large, slower) `items()` stock pull.
- `--dest DIR` overrides the default `${docsRoot}/<from>[_<to>]/api/` output location.

Output: one JSON file per document, named like the GUI export's PDFs (`invoicem_<N>.json`, etc,
by the org's real docNumber) plus `storeAvailability_<pmTo>.json` and a sha256 manifest
(`new`/`same`/`REPLACED`, idempotent re-runs) — same shape as `pull-plusminus-docs/pull.sh`'s.

## Safety — same rules as the GUI skill, enforced in code here, not just by discipline

- **Never evicts.** Checks the account slot (`clients()` over `/server`) before logging in and
  **exits** if it's held — there is no flag that overrides this. If `userLogin` returns `-2`
  (someone connected in the race between the check and the login), it also exits rather than
  evicting. Ask whoever is at the store PC, same as `export-gui.md` already says.
- **Always disconnects**, even on failure (`finally` block).
- Credentials are read from the org's `credsPath` (outside this public repo, gitignored-pattern)
  and never written to any output file or printed.

## The till (regal-pz): `--families posReceipts` (opt-in; verified live 2026-11-02)

regal-pz's cash register is not a `documents()` family: the POS module keeps its own receipt tables. `orgs.ts` gives the org a `pos`
block (`object`), and the pseudo-family `posReceipts` pulls it:

```bash
bun .claude/skills/pull-plusminus-api/pull-api.ts --org regal-pz --from 2026-10-27 --to 2026-10-29 --families posReceipts --no-snapshot
```

It calls `posDocuments(object, from, to, '', 'receipts')` (plus `layaways` and `posReversals`), buckets the receipts by the day they were
CLOSED (`header.closedOn`, the part before `:`) and writes one raw-array file per day: `posReceipts_<YYYYMMDD>.json`
(`posLayaways_` / `posReversals_` only on days that have any). It is opt-in so a default pull stays what it was.

Proven live on 2026-11-02: 137 receipts for 10-27..29 in 2 s, byte-identical to the one-shot capture, and the shipped mapper reproduces the
19 booked October days exactly (see `audit-regal-pz-period` §5 for the receipt rules and the proof). What the list holds: `КБ` cash receipts
(with `lines`) and `ПЛ` payments against invoices (no lines), so a day's file has more entries than sales. Then book it with
`scripts/import-cash-register-sales-api.ts --org regal-pz --dir <dir> --no-stock --dry-run` (and without `--dry-run`).

Slot rules are those of every pull: it exits 3 when something holds the account it signs in as, and never evicts. As `lgr-api` that can
only be another run of the tools; the 22:00–06:00 Sofia window matters only for a run on the admin account. On
2026-11-02 the owner said the store PC was free during the day and an idle admin GUI session (open since the morning, no GUI log entry, zero
CPU) was ended with the admin console's `disconnectClient` by the one-off `tools/evict-then-probe.ts`; that is deliberately NOT a feature of
this puller. Tools, runbook and the capture: `_docs/regal-pz/_till-capture/tools/README.md`.
