// orgs.ts — per-org PlusMinus /mobile connection + document-family config for pull-api.ts.
//
// ⚠ Nothing here is shared across orgs by assumption, and nothing should be. regal-pz and
// regal-sf run genuinely SEPARATE pmserver.exe installs (proven 2026-10-27: regal-sf's known
// document numbers — invoices 2000129xxx, till records 2222036xxx — do not appear in an
// unfiltered documents() listing against regal-pz's server on either of two days, and the one
// object name they share by coincidence, "ОБЕКТИ:СКЛАД", is a genuinely empty/unused placeholder
// on regal-pz's server — 0 products, confirmed live via items()). Same legal company name/EIK on
// both (РЕГАЛ ООД, 112500982) does NOT mean same database.
//
// ⚠ A document-type CODE's business meaning is per-org, not universal. Confirmed 2026-10-27 by
// reading a regal-sf screen recording: regal-sf's till/sales register comes back as type "СР" —
// the EXACT code regal-pz uses for store-to-store STOCK TRANSFERS (sklrazp). Never copy a
// `families` mapping from one org to another without live-verifying each type code's real
// meaning there (`documents()` with no `doc` filter, read `header.doc`/`header.comment` per
// entry — this is what caught the regal-sf "СР" collision, see pm-sf-probe findings in the
// handover record for exactly how).

export type DocFamily = { prefix: string; types: string[] }

export type OrgConfig = {
  id: string
  /** null = not yet discovered; pull-api.ts refuses with a clear message rather than guessing. */
  baseUrl: string | null
  company: string | null
  /** PlusMinus "обект" name as the API spells it (e.g. "ОБЕКТИ:СКЛАД - 1"). */
  warehouse: string | null
  /** Path to a `un: ...` / `pw: ...` credentials file, never committed. */
  credsPath: string | null
  /** Default output root — a day's pull lands at `${docsRoot}/<day>/api/`. */
  docsRoot: string
  /** doc-type -> output-file-prefix groups. Verify live before trusting for a NEW org. */
  families: DocFamily[]
  notes?: string
}

export const ORGS: Record<string, OrgConfig> = {
  'regal-pz': {
    id: 'regal-pz',
    baseUrl: 'https://100.65.4.26:7000',
    company: 'РЕГАЛ   ООД', // three spaces — see pull-plusminus-docs/SKILL.md
    warehouse: 'ОБЕКТИ:СКЛАД - 1',
    credsPath: 'C:/dev/gjovanov/plusminus.important',
    docsRoot: '//wsl.localhost/Ubuntu-24.04/home/gjovanov/gjovanov/_docs/regal-pz',
    families: [
      { prefix: 'invoicem', types: ['-ФЕ', '-ФЕА'] },
      { prefix: 'stokrazp', types: ['СТ'] },   // goods receipts (incl. "2000 КОРЕКЦИЯ" corrections)
      { prefix: 'sklrazp', types: ['СР'] },    // store-to-store transfers OUT (incl. to regal-sf)
      { prefix: 'sklisk', types: ['СИ'] },     // write-offs
    ],
  },
  'regal-sf': {
    id: 'regal-sf',
    // Reachable ONLY through device Regal-Dechko-SO (6a687648c8141b25961ebde6, per
    // regal_ssh.txt) — a private LAN address (192.168.0.103:7000, from "C:\plusminus7\login.json"
    // on that machine), confirmed unreachable directly from here (ECONNREFUSED; regal-pz's own
    // 100.65.4.26 is a Tailscale-range address and IS directly reachable — not comparable).
    // Tunnel it first, then pass --base-url (baseUrl stays null here on purpose — it is not a
    // fixed address):
    //   roomler forward --agent 6a687648c8141b25961ebde6 --local 17000 --remote 192.168.0.103:7000 --daemon
    //   bun pull-api.ts --org regal-sf --base-url https://127.0.0.1:17000 --from ...
    //   roomler kill fl-N   # fl-N from `roomler flows`, once done
    // 17000 is just the port used when this was proven 2026-10-27, not reserved — pick any free
    // local port. The forward can drop on its own (seen once live); re-run `roomler forward` and
    // retry if a call suddenly ECONNREFUSEs mid-session.
    baseUrl: null,
    company: 'РЕГАЛ   ООД', // confirmed live 2026-10-27 via companies() — same 3-space string as
    // regal-pz (same legal entity), on a genuinely separate server (see the warning above).
    warehouse: 'ОБЕКТИ:СКЛАД', // confirmed live: 26,722 products, 9,129 with qty>0. A second
    // object, "ПАРТНЬОРИ:СКЛАД:склад", also exists and is confirmed EMPTY (0 products) — a red
    // herring, same shape as regal-pz's own unused "ОБЕКТИ:СКЛАД" placeholder. Don't use it.
    credsPath: 'C:/dev/gjovanov/plusminus.important', // same admin account as regal-pz, per the
    // user directly (2026-10-27) — not a guess.
    docsRoot: '//wsl.localhost/Ubuntu-24.04/home/gjovanov/gjovanov/_docs/regal-sf',
    families: [
      { prefix: 'invoicem', types: ['-ФЕ'] }, // confirmed live: 36-55/day, numbered 2000129xxx.
      // -ФЕА not yet seen for this org; add once observed rather than assumed present.
      { prefix: 'stokrazp', types: ['СТ'] },
      // Goods receipts — SAME meaning as regal-pz's "СТ", confirmed three independent ways
      // 2026-10-27: the printed PDF ("СТОКОВА РАЗПИСКА за получаване на стоки"), the numeric
      // operations[].type field (1, matching regal-pz's own known-receipt sample exactly — a
      // known-sale sample is 2, known-transfer is 2 also but from "СР"), and the user directly
      // ("stokrazp can be in or out depending on the qty sign — same for both sf and pz"). 13-14
      // docs/day, numbered 2222036xxx.
      { prefix: 'storeOperations', types: ['СР'] },
      // Cash-register sales (the till) — per the user directly: "sklrazp in pz is used for
      // movement out e.g. transfer from pz to sf, and sklrazp in sf is used for cash register
      // sales (also movement out but via CRS)." Same STOCK DIRECTION as regal-pz's "СР"
      // (transfers), different real-world operation — that's exactly what cost real time here:
      // matching this family to the video's journal-list numbers (2222036xxx, which are actually
      // the stokrazp/"СТ" receipts above) instead of its own number series. The real one is much
      // larger and smaller-ticket: 42/35 docs/day, numbered ~21427-21503, most carrying a comment
      // linking back to a same-sale -ФЕ invoice (e.g. " -ФЕ 2000129222") — till receipt + fiscal
      // invoice for the same purchase, a normal pairing. Matches the GUI's Складови операции /
      // Операция:Продажби export (`storeOperations_*.xlsx`) and memory `lgr-regal-sf-org`'s
      // "storeOperations-Продажби" framing — that framing was right all along; two passes of
      // this investigation went looking in the wrong number series before landing on it.
      //
      // ⚠ `header.sum` (== `header.paid`) is VAT-INCLUSIVE; `lines[].sum` is NET. The aggregate
      // xlsx report's own printed total is net — matches Σ(lines[].sum) to the cent (410.29
      // computed vs 410.30 printed, 35 records, 2026-10-27), NOT Σ(header.sum) (492.34 — off by
      // exactly the ~20% VAT most lines carry). Compare against the aggregate report using
      // lines[].sum, never header.sum, or every comparison will look ~20% off for no real reason.
    ],
    // No sklisk/write-off type observed in two full days, matching memory `lgr-regal-sf-org`.
  },
}

export function getOrg(id: string): OrgConfig {
  const org = ORGS[id]
  if (!org) throw new Error(`pull-api: unknown --org "${id}". Known: ${Object.keys(ORGS).join(', ')}`)
  // baseUrl may legitimately be null in orgs.ts (an org reachable only through a roomler forward,
  // not a fixed address) — pull-api.ts's --base-url flag supplies it per run instead; checked
  // there, not here. Everything else must be on file.
  const missing = (['company', 'warehouse', 'credsPath'] as const).filter(k => !org[k])
  if (missing.length) {
    throw new Error(`pull-api: org "${id}" is missing ${missing.join(', ')} — see orgs.ts's notes for this org before filling these in; don't guess a value.${org.notes ? '\n' + org.notes : ''}`)
  }
  return org
}
