// orgs.ts — per-org PlusMinus /mobile connection + document-family config for pull-api.ts.
//
// The store's own identifiers are NOT in this file, because this repo is public: the server address, the company string, the
// local day folder and the credentials path come from the gitignored `.secrets/plusminus-stores.env` (see stores-env.ts), by the
// variable prefix each org declares below (PZ_PM_BASE_URL, PZ_PM_COMPANY, PZ_DOCS_ROOT, ...). A missing one fails with its name.
//
// ⚠ Nothing here is shared across orgs by assumption, and nothing should be. regal-pz and
// regal-sf run genuinely SEPARATE pmserver.exe installs (proven 2026-10-27: the document numbers
// known to belong to regal-sf do not appear in an unfiltered documents() listing against
// regal-pz's server on either of two days, and the one object name they share by coincidence,
// "ОБЕКТИ:СКЛАД", is a genuinely empty/unused placeholder on regal-pz's server — 0 products,
// confirmed live via items()). The same legal company name on both does NOT mean the same database.
//
// ⚠ A document-type CODE's business meaning is per-org, not universal. Confirmed 2026-10-27 by
// reading a regal-sf screen recording: regal-sf's till/sales register comes back as type "СР" —
// the EXACT code regal-pz uses for store-to-store STOCK TRANSFERS (sklrazp). Never copy a
// `families` mapping from one org to another without live-verifying each type code's real
// meaning there (`documents()` with no `doc` filter, read `header.doc`/`header.comment` per
// entry — this is what caught the regal-sf "СР" collision, see pm-sf-probe findings in the
// handover record for exactly how).
import { need, optional } from './stores-env'

export type DocFamily = { prefix: string; types: string[] }

export type OrgConfig = {
  id: string
  /** null = reachable only through a tunnel: pull-api.ts needs --base-url (see the regal-sf note below). */
  baseUrl: string | null
  /** The company string as the API spells it, invisible padding included (companies() returns it). */
  company: string
  /** PlusMinus "обект" name as the API spells it (e.g. "ОБЕКТИ:СКЛАД - 1"). */
  warehouse: string
  /** Path to a `un: ...` / `pw: ...` credentials file, never committed. */
  credsPath: string
  /** Default output root — a day's pull lands at `${docsRoot}/<day>/api/`. */
  docsRoot: string
  /** doc-type -> output-file-prefix groups. Verify live before trusting for a NEW org. */
  families: DocFamily[]
  /**
   * The till, when it is the POS module's own receipt tables rather than documents() (regal-pz). `object` is the POS
   * workplace's defaultObject (posObjects() reports it). Absent = the org's till, if it has one, comes back as ordinary
   * documents (regal-sf: storeOperations / СР). Pulled as the pseudo-family `posReceipts`.
   */
  pos?: { object: string }
  notes?: string
}

type OrgDef = {
  /** Variable prefix in .secrets/plusminus-stores.env: `<PREFIX>_PM_BASE_URL`, `<PREFIX>_PM_COMPANY`, `<PREFIX>_DOCS_ROOT`, optional `<PREFIX>_PM_CREDS`. */
  prefix: string
  /** The server has no fixed address from here: the caller opens a tunnel and passes --base-url. */
  viaTunnel?: boolean
  warehouse: string
  families: DocFamily[]
  pos?: { object: string }
  notes?: string
}

const DEFS: Record<string, OrgDef> = {
  'regal-pz': {
    prefix: 'PZ',
    warehouse: 'ОБЕКТИ:СКЛАД - 1',
    families: [
      { prefix: 'invoicem', types: ['-ФЕ', '-ФЕА'] },
      { prefix: 'stokrazp', types: ['СТ'] },   // goods receipts (incl. "2000 КОРЕКЦИЯ" corrections)
      { prefix: 'sklrazp', types: ['СР'] },    // store-to-store transfers OUT (incl. to regal-sf)
      { prefix: 'sklisk', types: ['СИ'] },     // write-offs
    ],
    // The till is NOT a documents() family here: posDocuments(object, from, to, '', 'receipts') — see pull-api.ts.
    pos: { object: 'ОБЕКТИ:СКЛАД - 1' },
  },
  'regal-sf': {
    prefix: 'SF',
    // Reachable ONLY through the till PC's Roomler agent (SF_ROOMLER_AGENT): its PlusMinus server is a private LAN
    // address (SF_PM_REMOTE), confirmed unreachable directly from here (ECONNREFUSED). regal-pz's overlay address, by
    // contrast, IS directly reachable — the two are not comparable. Tunnel it first, then pass --base-url (no fixed
    // address, on purpose):
    //   set -a && source .secrets/plusminus-stores.env && set +a
    //   roomler forward --agent "$SF_ROOMLER_AGENT" --local 17000 --remote "$SF_PM_REMOTE" --daemon
    //   bun pull-api.ts --org regal-sf --base-url https://127.0.0.1:17000 --from ...
    //   roomler kill fl-N   # fl-N from `roomler flows`, once done
    // 17000 is just the port used when this was proven 2026-10-27, not reserved — pick any free
    // local port. The forward can drop on its own (seen once live); re-run `roomler forward` and
    // retry if a call suddenly ECONNREFUSEs mid-session.
    viaTunnel: true,
    warehouse: 'ОБЕКТИ:СКЛАД', // confirmed live: the store's real stock. A second object, "ПАРТНЬОРИ:СКЛАД:склад",
    // also exists and is confirmed EMPTY (0 products) — a red herring, same shape as regal-pz's own unused
    // "ОБЕКТИ:СКЛАД" placeholder. Don't use it.
    families: [
      { prefix: 'invoicem', types: ['-ФЕ'] }, // confirmed live. -ФЕА not yet seen for this org; add once observed rather than assumed present.
      { prefix: 'stokrazp', types: ['СТ'] },
      // Goods receipts — SAME meaning as regal-pz's "СТ", confirmed three independent ways
      // 2026-10-27: the printed PDF ("СТОКОВА РАЗПИСКА за получаване на стоки"), the numeric
      // operations[].type field (1, matching regal-pz's own known-receipt sample exactly — a
      // known-sale sample is 2, known-transfer is 2 also but from "СР"), and the user directly
      // ("stokrazp can be in or out depending on the qty sign — same for both sf and pz"). Its
      // own number series, not the till's.
      { prefix: 'storeOperations', types: ['СР'] },
      // Cash-register sales (the till) — per the user directly: "sklrazp in pz is used for
      // movement out e.g. transfer from pz to sf, and sklrazp in sf is used for cash register
      // sales (also movement out but via CRS)." Same STOCK DIRECTION as regal-pz's "СР"
      // (transfers), different real-world operation — that's exactly what cost real time here:
      // matching this family to the journal-list numbers of the stokrazp/"СТ" receipts above
      // instead of its own number series. The real one is much larger and smaller-ticket, and
      // most entries carry a comment linking back to a same-sale -ФЕ invoice — till receipt +
      // fiscal invoice for the same purchase, a normal pairing. Matches the GUI's Складови
      // операции / Операция:Продажби export (`storeOperations_*.xlsx`) and memory
      // `lgr-regal-sf-org`'s "storeOperations-Продажби" framing — that framing was right all
      // along; two passes of this investigation went looking in the wrong number series first.
      //
      // ⚠ `header.sum` (== `header.paid`) is VAT-INCLUSIVE; `lines[].sum` is NET. The aggregate
      // xlsx report's own printed total is net — it matches Σ(lines[].sum) to the cent, NOT
      // Σ(header.sum), which is off by exactly the ~20% VAT most lines carry. Compare against
      // the aggregate report using lines[].sum, never header.sum, or every comparison will
      // look ~20% off for no real reason.
    ],
    // No sklisk/write-off type observed in two full days, matching memory `lgr-regal-sf-org`.
  },
}

export function getOrg(id: string): OrgConfig {
  const d = DEFS[id]
  if (!d) throw new Error(`pull-api: unknown --org "${id}". Known: ${Object.keys(DEFS).join(', ')}`)
  const p = d.prefix
  return {
    id,
    // baseUrl may legitimately be absent for an org reachable only through a tunnel — pull-api.ts's --base-url flag
    // supplies it per run instead; checked there, not here. Everything else must be on file.
    baseUrl: d.viaTunnel ? null : need(`${p}_PM_BASE_URL`),
    company: need(`${p}_PM_COMPANY`),
    warehouse: d.warehouse,
    credsPath: optional(`${p}_PM_CREDS`) ?? need('PM_CREDS'),
    docsRoot: need(`${p}_DOCS_ROOT`),
    families: d.families,
    pos: d.pos,
    notes: d.notes,
  }
}
