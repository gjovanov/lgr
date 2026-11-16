#!/usr/bin/env bun
// pull-api.ts — direct /mobile API pull of a PlusMinus day or date range: invoices, stock
// receipts, transfers, write-offs (per org's own `families` map in orgs.ts), and the stock
// snapshot. Parametrized by org, date range and warehouse — see orgs.ts for what "org" means
// and why nothing is shared between them by default.
//
// This script NEVER evicts another session. If the account slot is already held, it refuses and
// exits — ask whoever is at the till/store PC, don't force it. Always disconnects its own
// session when done, even on failure.
//
//   bun pull-api.ts --org regal-pz --from 2026-10-26 [--to 2026-10-27] [--dest DIR]
//                   [--warehouse NAME] [--no-snapshot] [--families invoicem,stokrazp]
//   bun pull-api.ts --org regal-pz --from 2026-10-27 --to 2026-10-29 --families posReceipts --no-snapshot   # the till (opt-in)
//   bun pull-api.ts --org regal-pz --from 2026-11-12 --families partners --no-snapshot                      # the partner directory (opt-in)
//
// Output mirrors the GUI export's naming (invoicem_<N>.json / stokrazp_<N>.json / ... /
// storeAvailability_<pmDay>.json) under `${docsRoot or --dest}/<from>[_<to>]/api/`.
//
// NOT wired into any import skill — this is the raw-extraction layer only.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { getOrg } from './orgs'
import { PARTNER_GROUPS_ARG } from '../../../packages/services/src/biz/doc-import/map-plusminus-partner'

const tls = { rejectUnauthorized: false } as any

function parseArgs() {
  const a = process.argv.slice(2)
  const get = (flag: string, def?: string) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : def }
  const org = get('--org')
  const from = get('--from')
  if (!org || !from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    console.error('usage: pull-api.ts --org <id> --from YYYY-MM-DD [--to YYYY-MM-DD] [--dest DIR] [--warehouse NAME] [--base-url URL] [--no-snapshot] [--families a,b,c]')
    process.exit(2)
  }
  const to = get('--to', from)!
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) { console.error('pull-api.ts: bad --to'); process.exit(2) }
  const famFilter = get('--families')?.split(',').map(s => s.trim())
  return {
    org, from, to,
    pmFrom: from.replace(/-/g, ''), pmTo: to.replace(/-/g, ''),
    warehouseOverride: get('--warehouse'),
    baseUrlOverride: get('--base-url'), // for an org only reachable through a roomler forward
    destOverride: get('--dest'),
    snapshot: !a.includes('--no-snapshot'),
    famFilter,
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** '' for a family's primary (first) type; '.fea' etc. for a later one, so same-numbered docs never share a file. */
function typeTag(fam: { types: string[] }, type: string): string {
  const i = fam.types.indexOf(type)
  if (i <= 0) return ''
  return '.' + (({ '-ФЕА': 'fea' } as Record<string, string>)[type] ?? `t${i}`)
}

// document()'s raw lines[] is not returned in printed order — confirmed both by evidence (the
// first invoice pulled 2026-10-27 had "no":"13" as its FIRST array element) and by the vendor's
// own client code, which defensively sorts before rendering a PDF
// (pmMobileStorePDFPrint.createPDF: `this.doc.lines.sort((e,t)=>Number(e.no||0)<Number(t.no||0)?-1:1)`,
// itself a broken comparator — never returns 0 for ties — kept here only as the evidence, not
// copied). Sort the same way, correctly, so the written JSON always matches print/line order.
function sortLines(doc: any) {
  if (Array.isArray(doc?.lines)) doc.lines.sort((a: any, b: any) => Number(a?.no ?? 0) - Number(b?.no ?? 0))
}

async function adminToken(baseUrl: string, un: string, pw: string) {
  const r = await fetch(`${baseUrl}/login`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: un, password: pw }).toString(), tls,
  } as any)
  const tok = (await r.text()).match(/id=token name=token style=display:none value=([0-9a-f-]+)/)?.[1]
  if (!tok) throw new Error(`admin login failed, status ${r.status}`)
  return tok
}

type ManifestRow = { file: string; size: number; sha256: string; state: 'new' | 'same' | 'REPLACED' }

async function main() {
  const { org: orgId, from, to, pmFrom, pmTo, warehouseOverride, baseUrlOverride, destOverride, snapshot, famFilter } = parseArgs()
  const org = getOrg(orgId) // throws a clear message if this org isn't configured yet — never guesses
  const baseUrl = baseUrlOverride ?? org.baseUrl
  if (!baseUrl) {
    console.error(`pull-api.ts: org "${orgId}" has no baseUrl on file and none was given with --base-url.${org.notes ? '\n' + org.notes : ''}`)
    process.exit(2)
  }
  const warehouse = warehouseOverride ?? org.warehouse!
  const dest = destOverride ?? `${org.docsRoot}/${from}${to !== from ? `_${to}` : ''}/api`
  // `posReceipts` is a pseudo-family: the till (POS) receipts, which live outside documents() — see the POS block below.
  // `partners` is another: the analytic partner directory (customers, suppliers) with its properties, one `apProperties` call.
  const docFilter = famFilter?.filter(f => f !== 'posReceipts' && f !== 'partners')
  const families = docFilter ? org.families.filter(f => docFilter.includes(f.prefix)) : org.families
  if (docFilter && families.length !== docFilter.length) {
    console.error(`pull-api.ts: --families named something not in ${orgId}'s family list (${org.families.map(f => f.prefix).join(', ')}${org.pos ? ', posReceipts' : ''}, partners)`)
    process.exit(2)
  }
  const wantPartners = !!famFilter?.includes('partners')
  if (famFilter?.includes('posReceipts') && !org.pos) {
    console.error(`pull-api.ts: org "${orgId}" has no POS config (orgs.ts \`pos\`), so there is no till to pull.`)
    process.exit(2)
  }
  // Opt-in only (`--families posReceipts`): a default pull must stay what it always was, and a month of receipts is large.
  const wantPos = !!org.pos && !!famFilter?.includes('posReceipts')

  const raw = readFileSync(org.credsPath, 'utf8').replace(/^﻿/, '')
  const un = raw.match(/^un:\s*(.*)$/m)?.[1]?.trim() ?? ''
  const pw = raw.match(/^pw:\s*(.*)$/m)?.[1]?.trim() ?? ''
  if (!un || !pw) { console.error('pull-api.ts: the credentials file did not parse (expected `un: ...` and `pw: ...` lines)'); process.exit(2) }

  // The admin console (/login -> /server) is a pre-check only: it lists the connected clients, so a held slot is reported before
  // userLogin has to. A dedicated account may not be allowed into the console at all, so a refusal here is not fatal: userLogin
  // answers -2 for a held slot too, and a wrong password stops there.
  let admin = ''
  try {
    admin = await adminToken(baseUrl, un, pw)
  } catch (e: any) {
    console.error(`pull-api.ts: no admin-console token for "${un}" (${e?.message ?? e}); skipping the clients() pre-check, userLogin still guards the slot.`)
  }
  async function server(arr: any[]) {
    const r = await fetch(`${baseUrl}/server`, { method: 'POST', headers: { Authorization: admin, 'Content-Type': 'application/json' }, body: JSON.stringify(arr), tls } as any)
    return await r.text()
  }
  if (admin) {
    const before = await server(['clients'])
    if (before.split(',').map(s => s.trim()).includes(un)) {
      console.error(`pull-api.ts: account "${un}" is already connected on ${orgId} (clients: ${before}) — most likely the till's own GUI.`)
      console.error('This script never evicts another session. Ask whoever is at the store PC to free it, or confirm it is idle and free it yourself over the admin console, then re-run.')
      process.exit(3)
    }
  }

  let tok = ''
  async function m(arr: any[], timeoutMs = 60000) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
    if (tok) headers.Authorization = tok
    const r = await fetch(`${baseUrl}/mobile`, { method: 'POST', headers, body: JSON.stringify(arr), tls, signal: AbortSignal.timeout(timeoutMs) } as any)
    return await r.text()
  }
  const li = await m(['userLogin', un, pw])
  if (li === '-2') { console.error('pull-api.ts: userLogin -> -2 (someone connected between the check and now) — not evicting, exiting.'); process.exit(3) }
  if (li.length <= 10) { console.error(`pull-api.ts: userLogin failed: ${JSON.stringify(li)}`); process.exit(1) }
  tok = li

  mkdirSync(dest, { recursive: true })
  const manifest: ManifestRow[] = []
  const write = (name: string, content: string) => {
    const path = `${dest}/${name}`
    const sha = sha256(content)
    let state: ManifestRow['state'] = 'new'
    if (existsSync(path)) state = sha256(readFileSync(path, 'utf8')) === sha ? 'same' : 'REPLACED'
    writeFileSync(path, content)
    manifest.push({ file: name, size: content.length, sha256: sha, state })
  }

  try {
    const sel = await m(['companySelect', org.company!])
    if (sel !== 'true') throw new Error(`companySelect(${org.company}) -> ${JSON.stringify(sel)}`)

    for (const fam of families) {
      const numbers: number[] = []
      const secondary: string[] = [] // docs of a family's 2nd+ type (e.g. -ФЕА annulments): see typeTag()
      for (const type of fam.types) {
        const listRaw = await m(['documents', pmFrom, pmTo, '', 'forward', JSON.stringify({ doc: type, get: 'h' }), 'false'])
        let entries: any[] = []
        try { entries = JSON.parse(listRaw || '[]') } catch {
          console.error(`${fam.prefix}/${type}: documents() returned non-JSON: ${listRaw.slice(0, 200)}`); continue
        }
        for (const e of entries) {
          if (!e?.date || e?.num === undefined) continue
          const full = await m(['document', `${e.date}\\${e.num}`, ''])
          let parsed: any
          try { parsed = JSON.parse(full || '{}') } catch { console.error(`document(${e.date}\\${e.num}) non-JSON, skipping`); continue }
          sortLines(parsed)
          const n = Number(parsed?.header?.docNumber ?? e?.header?.docNumber ?? '')
          // ⚠ A family's 2nd+ type can REUSE the first type's document number: PlusMinus annuls an
          // invoice with a -ФЕА that carries the SAME number and a negative sum (regal-pz, found
          // 2026-11-01). Written under one name, the annulment silently
          // overwrote the invoice it annuls. A tagged name keeps both, and the importers' strict
          // /^invoicem_(\d+)\.json$/ never matches it, so an annulment is never imported as an invoice.
          const tag = typeTag(fam, type)
          if (tag) { if (n) secondary.push(`${type} ${n}`) } else if (n) numbers.push(n)
          write(`${fam.prefix}_${parsed?.header?.docNumber ?? e.num}${tag}.json`, JSON.stringify(parsed, null, 2))
        }
      }
      numbers.sort((a, b) => a - b)
      if (numbers.length) {
        const gaps: string[] = []
        for (let i = 1; i < numbers.length; i++) if (numbers[i] !== numbers[i - 1] + 1) gaps.push(`${numbers[i - 1] + 1}-${numbers[i] - 1}`)
        console.log(`${fam.prefix.padEnd(10)} ${String(numbers.length).padStart(3)}  ${numbers[0]}..${numbers[numbers.length - 1]}${gaps.length ? '  GAPS:' + gaps.join(' ') : ''}`)
      } else {
        console.log(`${fam.prefix.padEnd(10)}   0`)
      }
      if (secondary.length) console.log(`${''.padEnd(10)} + ${secondary.length} secondary-type doc(s), written as <prefix>_<N>.<tag>.json: ${secondary.join(', ')}`)
    }

    // The till. regal-pz's cash register is not in documents(): the POS module keeps its own receipt tables, read with
    // posDocuments(object, from, to, '', kind). Wire shape = the vendor client's own wrappers (pmserver.exe's embedded JS):
    //   pm.posReceipts = (e,t,n,s) => request(["posDocuments", e, t, n, s||"", "receipts"])   // + "layaways"
    //   pm.posReversals = (e,t,n)  => request(["posReversals", e, t, n, "reversals"])
    // The last argument is a KIND discriminator; omitting it (the 6-arg documents() shape) returns nothing — that was the
    // whole reason the till looked "not in the API". Receipts are bucketed by the day they were CLOSED (the till's business
    // day) and written one file per day, the raw array exactly as the API returned it:
    //   posReceipts_<YYYYMMDD>.json  (+ posLayaways_/posReversals_ only on days that have any, so nothing is dropped silently)
    if (wantPos) {
      const obj = org.pos!.object
      for (const [kind, call, file] of [
        ['receipts', ['posDocuments', obj, pmFrom, pmTo, '', 'receipts'], 'posReceipts'],
        ['layaways', ['posDocuments', obj, pmFrom, pmTo, '', 'layaways'], 'posLayaways'],
        ['reversals', ['posReversals', obj, pmFrom, pmTo, 'reversals'], 'posReversals'],
      ] as Array<[string, any[], string]>) {
        const rawPos = await m(call, 180000)
        let all: any[] = []
        try { all = JSON.parse(rawPos || '[]') } catch { console.error(`${file}: ${call[0]} returned non-JSON: ${rawPos.slice(0, 200)}`); continue }
        if (!Array.isArray(all)) { console.error(`${file}: expected an array, got ${typeof all}`); continue }
        const byDay = new Map<string, any[]>()
        let undated = 0
        for (const r of all) {
          const day = String(r?.header?.closedOn ?? r?.header?.openedOn ?? '').split(':')[0]
          if (!/^\d{8}$/.test(day)) { undated++; continue }
          if (day < pmFrom || day > pmTo) continue // the range is inclusive, but never trust a server to filter
          ;(byDay.get(day) ?? byDay.set(day, []).get(day)!).push(r)
        }
        // receipts is always written per requested day that has any; the other kinds only when non-empty
        for (const [day, rs] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) write(`${file}_${day}.json`, JSON.stringify(rs, null, 2))
        console.log(`${file.padEnd(14)} ${String(all.length).padStart(5)} ${kind} on ${byDay.size} day(s)${undated ? `  ⚠ ${undated} without a usable closedOn/openedOn (not written)` : ''}`)
      }
    }

    // The partner directory (opt-in, `--families partners`). The vendor's own client loads every partner group with ONE call,
    // `pm.apProperties("ДОСТАВЧИЦИ:; КЛИЕНТИ:; ПАРТНЬОРИ:; КОНТРАГЕНТИ:")` (its `loadPartners`), which answers
    // `{ "КЛИЕНТИ:Name": { БУЛСТАТ, ИНДДС, АДРЕС, ГРАД, МОЛ, … } }`: about 1 MB for a shop. Read only, no document touched.
    // Written with its keys sorted, so the same directory is the same bytes and the manifest says `same`.
    if (wantPartners) {
      const rawPartners = await m(['apProperties', PARTNER_GROUPS_ARG], 180000)
      let directory: Record<string, unknown>
      try { directory = JSON.parse(rawPartners || '{}') } catch { throw new Error(`partners: apProperties returned non-JSON: ${rawPartners.slice(0, 200)}`) }
      if (!directory || typeof directory !== 'object' || Array.isArray(directory)) throw new Error('partners: expected an object of partners')
      const sorted = Object.fromEntries(Object.keys(directory).sort().map(k => [k, directory[k]]))
      write('partners.json', JSON.stringify(sorted, null, 2))
      const byGroup = new Map<string, number>()
      for (const k of Object.keys(sorted)) { const g = k.includes(':') ? k.slice(0, k.indexOf(':')) : '(no group)'; byGroup.set(g, (byGroup.get(g) ?? 0) + 1) }
      console.log(`${'partners'.padEnd(10)} ${String(Object.keys(sorted).length).padStart(5)} entries: ${[...byGroup].map(([g, n]) => `${g} ${n}`).join(', ')}`)
    }

    if (snapshot) {
      const rawItems = await m(['items', JSON.stringify({ warehouse })], 120000)
      let parsed: any = {}
      try { parsed = JSON.parse(rawItems || '{}') } catch { console.error('items(): non-JSON response, snapshot not written') }
      const inner = parsed[warehouse] ?? parsed
      const count = Object.keys(inner).length
      const zero = Object.values(inner).filter((v: any) => !v?.quantity || Number(v.quantity) === 0).length
      write(`storeAvailability_${pmTo}.json`, JSON.stringify(parsed, null, 2))
      console.log(`${'snapshot'.padEnd(10)} ${count} products, ${zero} at zero quantity`)
    }
  } finally {
    await m(['disconnect']).catch(() => {})
  }

  writeFileSync(`${dest}/pull-api-manifest.txt`,
    manifest.map(x => `${x.state.padEnd(9)} ${x.file.padEnd(42)} ${String(x.size).padStart(9)}  ${x.sha256.slice(0, 12)}`).join('\n') + '\n')
  console.log(`\n--- ${dest}`)
  for (const x of manifest) console.log(`${x.state.padEnd(9)} ${x.file}`)
}

main().catch(e => { console.error('pull-api.ts: FAILED:', e?.message ?? e); process.exit(1) })
