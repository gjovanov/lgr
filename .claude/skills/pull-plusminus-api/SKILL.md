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
and a `families` map (doc-type codes → output prefix). **Never copy a working org's config to a
new one and assume it mostly applies.** Proven live 2026-10-27, both ways:

- **Same-looking company ≠ same server.** regal-pz and regal-sf's PlusMinus both show company
  "РЕГАЛ ООД" (same EIK), but are genuinely separate `pmserver.exe` installs — an unfiltered
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

`getOrg(id)` refuses (doesn't guess) when `company`/`warehouse`/`credsPath` is unfilled.
`baseUrl` may legitimately be `null` in `orgs.ts` itself — see "Orgs reachable only through a
tunnel" below — checked separately, in `pull-api.ts`, once `--base-url` has had a chance to
supply it.

## Adding a new org

1. Get a server address + a `un`/`pw` credentials file (same two-line format as regal-pz's
   `plusminus.important`, never committed) for that install specifically — don't assume another
   org's server or credentials extend to it. A private LAN address (`192.168.x.x`) won't be
   reachable directly the way regal-pz's Tailscale-range one is — see the tunnel section below
   before concluding an org is unreachable.
2. One minimal **read-only** live check, same discipline as below: `companies()` (confirm the
   exact company string — it may have invisible padding, as regal-pz's does: `"РЕГАЛ   ООД"` with
   three internal spaces, not one), `objects()` (confirm the real warehouse string — and check
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

Not every org's server is directly reachable. regal-sf's is a private LAN address behind device
Regal-Dechko-SO, confirmed unreachable from outside that network. The fix is a `roomler forward`
(not `ssh`/`exec` — no bootstrapping needed on the target device for this), then `--base-url`:

```bash
roomler forward --agent 6a687648c8141b25961ebde6 --local 17000 --remote 192.168.0.103:7000 --daemon
bun .claude/skills/pull-plusminus-api/pull-api.ts --org regal-sf --base-url https://127.0.0.1:17000 --from 2026-10-27
roomler kill fl-N   # fl-N from `roomler flows` — tear it down when done
```

The local port isn't reserved — pick any free one. The forward can drop on its own mid-session
(seen once live, no PlusMinus-side cause): a sudden `ECONNREFUSED` on a call that was working
means re-run `roomler forward` and retry, not that the org's config is wrong. Leave other flows
in `roomler flows` alone — this machine may have unrelated forwards already running.

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
