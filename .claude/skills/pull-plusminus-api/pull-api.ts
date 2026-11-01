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
//
// Output mirrors the GUI export's naming (invoicem_<N>.json / stokrazp_<N>.json / ... /
// storeAvailability_<pmDay>.json) under `${docsRoot or --dest}/<from>[_<to>]/api/`.
//
// NOT wired into any import skill — this is the raw-extraction layer only.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { getOrg } from './orgs'

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
  const families = famFilter ? org.families.filter(f => famFilter.includes(f.prefix)) : org.families
  if (famFilter && families.length !== famFilter.length) {
    console.error(`pull-api.ts: --families named something not in ${orgId}'s family list (${org.families.map(f => f.prefix).join(', ')})`)
    process.exit(2)
  }

  const raw = readFileSync(org.credsPath!, 'utf8').replace(/^﻿/, '')
  const un = raw.match(/^un:\s*(.*)$/m)?.[1]?.trim() ?? ''
  const pw = raw.match(/^pw:\s*(.*)$/m)?.[1]?.trim() ?? ''
  if (!un || !pw) { console.error(`pull-api.ts: credentials file ${org.credsPath} did not parse`); process.exit(2) }

  const admin = await adminToken(baseUrl, un, pw)
  async function server(arr: any[]) {
    const r = await fetch(`${baseUrl}/server`, { method: 'POST', headers: { Authorization: admin, 'Content-Type': 'application/json' }, body: JSON.stringify(arr), tls } as any)
    return await r.text()
  }
  const before = await server(['clients'])
  if (before.split(',').map(s => s.trim()).includes(un)) {
    console.error(`pull-api.ts: account "${un}" is already connected on ${orgId} (clients: ${before}) — most likely the till's own GUI.`)
    console.error('This script never evicts another session. Ask whoever is at the store PC to free it, or confirm it is idle and free it yourself over the admin console, then re-run.')
    process.exit(3)
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
          if (n) numbers.push(n)
          write(`${fam.prefix}_${parsed?.header?.docNumber ?? e.num}.json`, JSON.stringify(parsed, null, 2))
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
