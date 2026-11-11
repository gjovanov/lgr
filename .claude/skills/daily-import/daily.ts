#!/usr/bin/env bun
// daily.ts — one day's PlusMinus → LGR import, phase by phase: the same commands, the same file names and the same
// checks every day. Each phase runs the existing tools, keeps their full output in the day's evidence folder, and ends
// on a short list of findings:
//
//   ok    checked and fine            note  worth a line in the report
//   ACT   decide or do something before the run goes on      STOP  do not go on
//
// Exit code 1 when a phase has a STOP. `book` is the only phase that writes to LGR, only with --execute, and only after
// its own fresh dry run of the same selection came back without ACT or STOP.
//
//   bun .claude/skills/daily-import/daily.ts <phase> --org <slug> [options]
//
//   plan                     the day, the previous run, the folders, the last numbers (no --org: every org)
//   grant                    does the LGR session read everything: costs, every price level (needs LGR)
//   pull                     the day's documents and the stock snapshot from PlusMinus
//   history                  re-pull the whole history, diff it against the previous run's, find back-dated documents
//   scan                     which documents of the day moved no stock; till returns; items outside the goods group
//   predict                  audit, compare, the prediction, the price snapshot (needs LGR)
//   dry                      dry runs of every importer the day needs (needs LGR)
//   book --family <f>        receipts | transfers | writeoffs | till | invoices: dry, check, then --execute writes
//   after                    pull again, prove PlusMinus stood still, compare
//   prices                   price snapshot after, and every change named by a receipt line
//   rerun                    dry reruns: nothing may be left to book
//   audit                    the audit after booking
//   facts                    the day's figures for the report, from the evidence
//
// Options: --day YYYY-MM-DD (default: today in Sofia) · --from YYYY-MM-DD (first unbooked day, default --day) ·
//   --prev <evidence folder name> · --suffix eve|late (default eve) · --base-url URL (an org behind a tunnel; or
//   PLUSMINUS_BASE_URL) · --session <tag> (reads .secrets/lgr-session-<tag>.env; or LGR_SESSION_TAG; else the env) ·
//   --only n,n · --dir DIR (book or dry from another folder: a corrected copy, a history chunk) · --date YYYY-MM-DD
//   (one till day of a range) · --no-pull (history: diff what is already pulled) · --execute
//
// The org's identifiers (document root, PlusMinus server) come from .secrets/plusminus-stores.env by name
// (../pull-plusminus-api/stores-env.ts); nothing of them is in this file. The checks are scripts/lib/daily-import.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getOrg } from '../pull-plusminus-api/orgs'
import { loadStoresEnv } from '../pull-plusminus-api/stores-env'
import {
  diffPulls, docFiles, finding, gateAuditAfter, gateAuditBefore, gateBooked, gateCompare, gateDry, gateHistory, gatePredict,
  gatePrices, gateSameDay, gateScan, newOutsideDay, numberGaps, parseAudit, parseCompare, parseInvoicesLog, parseMovesLog, parsePredict,
  parsePriceDiff, parsePull, parseReceiptsLog, parseTillLog, sameDay, scanDay, unread, DOC_FILE, FAMILIES, type Family, type Finding,
} from '../../../scripts/lib/daily-import'

// ── What the import knows about each org, beyond what the puller knows ──────────────────────────────────────────────
const IMPORT: Record<string, { historyFrom: string; baseline: string }> = {
  // LGR's quantities were set to PlusMinus's on the baseline day: a document dated on or before it is already inside them.
  'regal-pz': { historyFrom: '2026-07-21', baseline: '2026-07-30' },
  'regal-sf': { historyFrom: '2026-09-30', baseline: '2026-09-30' },
}
/** The files of a day folder that make a family present. */
const FAMILY_FILES: Record<Family, RegExp> = {
  receipts: /^stokrazp_\d+\.json$/, transfers: /^sklrazp_\d+\.json$/, writeoffs: /^sklisk_\d+\.json$/,
  till: /^(storeOperations_\d+|posReceipts_\d{8})\.json$/, invoices: /^invoicem_\d+\.json$/,
}

// ── Arguments ───────────────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const phase = argv[0] && !argv[0].startsWith('--') ? argv.shift()! : ''
const opt = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined }
const has = (name: string) => argv.includes(`--${name}`)
const ISO = /^\d{4}-\d{2}-\d{2}$/
const sofiaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date())
const day = opt('day') ?? sofiaToday()
const from = opt('from') ?? day
const suffix = opt('suffix') ?? 'eve'
if (!ISO.test(day) || !ISO.test(from) || from > day) die(`--day and --from must be YYYY-MM-DD, with --from on or before --day (got ${from} … ${day})`)
const period = from === day ? day : `${from}…${day}`
const root = resolve(import.meta.dir, '../../..')
const skill = import.meta.dir
const stamp = () => new Date().toISOString().slice(11, 19)

function die(message: string): never { console.error(`daily.ts: ${message}`); process.exit(2) }

// ── The LGR session ─────────────────────────────────────────────────────────────────────────────────────────────────
/** `imp<ddmm>` of the day AFTER the one imported: the temp admin of that run, by this lane's convention. */
function defaultTag(): string {
  const next = new Date(`${day}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1)
  const iso = next.toISOString()
  return `imp${iso.slice(8, 10)}${iso.slice(5, 7)}`
}
const sessionTag = opt('session') ?? process.env.LGR_SESSION_TAG ?? defaultTag()
function loadSession(): void {
  if (process.env.LGR_TOKEN || (process.env.LGR_USERNAME && process.env.LGR_PASSWORD)) return
  const stores = loadStoresEnv()
  const file = stores ? join(dirname(stores), `lgr-session-${sessionTag}.env`) : ''
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(LGR_[A-Z_]+)=(.*)$/.exec(line)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
    }
  }
  if (!process.env.LGR_TOKEN && !(process.env.LGR_USERNAME && process.env.LGR_PASSWORD)) {
    die(`this phase reads LGR: no LGR_USERNAME + LGR_PASSWORD in the environment and none in ${file || '.secrets/lgr-session-<tag>.env'} (the temp-admin skill writes that file; --session <tag> names another)`)
  }
}

// ── Folders ─────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Ctx {
  org: string
  docsRoot: string
  store: string
  hasPos: boolean
  baseUrl: string | null
  tunnelled: boolean
  baseline: string
  historyFrom: string
  /** The day's own pull. */
  pulled: string
  /** The folder booked from: the day's pull, or --dir. */
  dayDir: string
  ev: string
  out: string
  prev: string | null
}
const CHUNK = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/
const chunkDirs = (ev: string): string[] => (existsSync(ev) ? readdirSync(ev).filter(n => CHUNK.test(n)).sort().map(n => join(ev, n, 'api')).filter(d => existsSync(d)) : [])

function context(org: string): Ctx {
  const cfg = IMPORT[org]
  if (!cfg) die(`unknown --org "${org}". Known: ${Object.keys(IMPORT).join(', ')}`)
  const o = getOrg(org)
  holdShare(o.docsRoot)
  const evName = `_audit-${day}-${suffix}`
  const ev = join(o.docsRoot, evName)
  let prev = opt('prev') ?? null
  if (!prev) {
    const older = readdirSync(o.docsRoot).filter(n => /^_audit-\d{4}-\d{2}-\d{2}-[a-z]+$/.test(n) && n < evName && chunkDirs(join(o.docsRoot, n)).length).sort()
    prev = older.at(-1) ?? null
  }
  const pulled = join(o.docsRoot, from === day ? day : `${from}_${day}`, 'api')
  return {
    org, docsRoot: o.docsRoot, store: o.warehouse, hasPos: !!o.pos, baseline: cfg.baseline, historyFrom: cfg.historyFrom,
    baseUrl: opt('base-url') ?? process.env.PLUSMINUS_BASE_URL ?? o.baseUrl, tunnelled: o.baseUrl === null,
    pulled, dayDir: opt('dir') ?? pulled, ev, out: join(ev, 'out'), prev: prev ? join(o.docsRoot, prev) : null,
  }
}

/**
 * A document root on a WSL share exists only while its distro runs, and WSL stops an idle distro within seconds. Hold
 * it for the length of this process.
 */
let held = false
function holdShare(path: string): void {
  const m = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)/i.exec(path)
  if (!m || held) return
  held = true
  const child = Bun.spawn(['wsl.exe', '-d', m[1], '-e', 'sleep', '7200'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  process.on('exit', () => { try { child.kill() } catch { /* already gone */ } })
  for (let i = 0; i < 60; i++) { try { readdirSync(path); return } catch { Bun.sleepSync(500) } }
  die(`the document root ${path} did not become readable`)
}

// ── Running the tools ───────────────────────────────────────────────────────────────────────────────────────────────
function freeName(dir: string, base: string): string {
  if (!existsSync(join(dir, `${base}.txt`))) return join(dir, `${base}.txt`)
  for (let n = 2; ; n++) if (!existsSync(join(dir, `${base}-${n}.txt`))) return join(dir, `${base}-${n}.txt`)
}
function run(label: string, args: string[], file: string): { code: number; text: string } {
  mkdirSync(dirname(file), { recursive: true })
  const started = Date.now()
  const r = Bun.spawnSync(['bun', ...args], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  const text = r.stdout.toString() + (r.stderr.length ? `\n${r.stderr.toString()}` : '')
  writeFileSync(file, text)
  console.log(`[${stamp()}] ${label}: exit ${r.exitCode} in ${((Date.now() - started) / 1000).toFixed(0)} s → ${file}`)
  return { code: r.exitCode ?? 1, text }
}
const read = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null)
const pullScript = '.claude/skills/pull-plusminus-api/pull-api.ts'
const serverArgs = (c: Ctx) => (c.tunnelled ? ['--base-url', c.baseUrl!] : [])
function needServer(c: Ctx): void {
  if (!c.baseUrl) die(`${c.org}'s PlusMinus server is reached through a tunnel: open the forward and pass --base-url https://127.0.0.1:<port> (pull-plusminus-api, "Orgs reachable only through a tunnel")`)
}
const snapshotIn = (dir: string) => { const f = existsSync(dir) ? readdirSync(dir).find(n => /^storeAvailability_\d+\.json$/.test(n)) : undefined; return f ? join(dir, f) : null }
const present = (dir: string, family: Family) => existsSync(dir) && readdirSync(dir).some(f => FAMILY_FILES[family].test(f))

/** The highest document number per family in a set of pulled folders. */
function lastNumbers(dirs: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const d of dirs) for (const f of docFiles(d)) {
    const [, family, number, tag] = DOC_FILE.exec(f)!
    if (!tag) m.set(family, Math.max(m.get(family) ?? 0, Number(number)))
  }
  return m
}

// ── Phases ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function plan(): Finding[] {
  const orgs = opt('org') ? [opt('org')!] : Object.keys(IMPORT)
  const now = new Date()
  console.log(`day ${period} | Sofia today ${sofiaToday()} | UTC ${now.toISOString().slice(11, 16)} | session tag ${sessionTag}`)
  const out: Finding[] = []
  // The stores enter documents until after they close: pz has entered receipts as late as 18:43 Sofia.
  if (day === sofiaToday() && now < new Date(`${sofiaToday()}T17:15:00Z`)) out.push(finding('stop', `it is before 17:15 UTC: the stores still enter documents for ${day}`))
  else out.push(finding('ok', day === sofiaToday() ? 'past 17:15 UTC' : `${day} is a past day`))
  for (const org of orgs) {
    const c = context(org)
    const last = c.prev ? lastNumbers(chunkDirs(c.prev)) : new Map<string, number>()
    const pad = ' '.repeat(org.length)
    console.log(`${org}: day folder ${c.pulled}`)
    console.log(`${pad}  evidence   ${c.ev}`)
    console.log(`${pad}  previous   ${c.prev ?? '(none found: pass --prev)'}`)
    console.log(`${pad}  last numbers in the previous history: ${[...last].map(([k, n]) => `${k} ${n}`).join(', ') || '(none)'}`)
    if (!c.prev) out.push(finding('act', `${org}: no previous evidence folder with history chunks: the history diff has nothing to compare against`))
    if (existsSync(c.ev) && readdirSync(c.ev).length) out.push(finding('note', `${org}: ${c.ev} already holds files: a second run today takes --suffix late`))
    if (c.tunnelled) out.push(finding('note', `${org}: reached through a tunnel, pass --base-url to pull, history and after`))
  }
  return out
}

/**
 * Does this session read everything? A role may be shown a product without its cost figures or some price levels, and
 * a read that is shown less makes a wrong write: a compare without average costs, a price snapshot without purchase
 * prices. Checked live, before the first read of a run.
 */
async function grant(c: Ctx): Promise<Finding[]> {
  loadSession()
  const api = (process.env.LGR_API ?? 'https://lgrai.app').replace(/\/$/, '')
  const json = async (path: string, init?: RequestInit) => { const r = await fetch(`${api}${path}`, init); return { status: r.status, body: (await r.json().catch(() => ({}))) as any } }
  let token = process.env.LGR_TOKEN ?? ''
  if (!token) {
    const login = await json('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgSlug: c.org, username: process.env.LGR_USERNAME, password: process.env.LGR_PASSWORD }) })
    if (login.status !== 200 || !login.body.token) return [finding('stop', `sign-in to ${c.org} answered ${login.status}`)]
    token = login.body.token
  }
  const auth = { headers: { authorization: `Bearer ${token}` } }
  const me = await json('/api/auth/me', auth)
  const orgId = me.body?.org?.id ?? me.body?.user?.orgId
  if (me.status !== 200 || !orgId) return [finding('stop', `/auth/me answered ${me.status}`)]
  const out: Finding[] = []
  const access = me.body.access
  if (access && !access.all) out.push(finding('stop', `this session's role is not the full grant (${access.caps?.length ?? '?'} capabilities, role "${access.role?.name ?? '?'}"): it may be shown less than the records hold`))
  else out.push(finding(me.body.user?.role === 'admin' ? 'ok' : 'stop', `signed in to ${c.org} as role "${me.body.user?.role}"; ${access ? 'its role grants everything' : "the token's claims decide"}`))
  const products = await json(`/api/org/${orgId}/warehouse/product?page=0&size=20`, auth)
  const list: any[] = products.body.products ?? []
  const tiered = list.find(p => Array.isArray(p.priceTiers) && p.priceTiers.length)
  const levels = await json(`/api/org/${orgId}/warehouse/stock-level?page=0&size=5`, auth)
  const level = (levels.body.stockLevels ?? [])[0]
  const reads: Record<string, boolean> = {
    'the purchase price': list.length > 0 && list.every(p => 'purchasePrice' in p),
    'the selling price': list.length > 0 && list.every(p => 'sellingPrice' in p),
    "each tier's margin": !!tiered && tiered.priceTiers.every((t: any) => 'percent' in t),
    'the cost tier': !!tiered && tiered.priceTiers.some((t: any) => String(t.name).replace(/\s+/g, '') === 'Доставнацена'),
    'the average cost': !!level && 'avgCost' in level,
  }
  const blind = Object.entries(reads).filter(([, ok]) => !ok).map(([what]) => what)
  if (products.status !== 200 || levels.status !== 200) out.push(finding('stop', `the product list answered ${products.status}, the stock levels ${levels.status}`))
  else if (blind.length) out.push(finding('stop', `this session does not see ${blind.join(', ')}: a read that is shown less makes a wrong write`))
  else out.push(finding('ok', `it reads everything: ${Object.keys(reads).join(', ')} (${products.body.total ?? '?'} products)`))
  return out
}

function pull(c: Ctx): Finding[] {
  needServer(c)
  const main = run('pull', [pullScript, '--org', c.org, '--from', from, '--to', day, ...serverArgs(c)], join(c.out, 'pull.txt'))
  if (main.code === 3) return [finding('stop', 'the PlusMinus account is in use (exit 3). Find out whose session it is. Never evict it.')]
  if (main.code !== 0) return [finding('stop', `the pull failed (exit ${main.code}): read ${join(c.out, 'pull.txt')}`)]
  const p = parsePull(main.text)
  if (!p.families.length) return [unread('the pull summary')]
  const out: Finding[] = []
  const prevLast = c.prev ? lastNumbers(chunkDirs(c.prev)) : new Map<string, number>()
  for (const f of p.families) {
    out.push(finding(f.gaps ? 'act' : 'ok', `${f.prefix}: ${f.count}${f.first ? ` (${f.first}..${f.last})` : ''}${f.gaps ? ` GAPS ${f.gaps}: a number missing inside the day's range` : ''}`))
    const before = prevLast.get(f.prefix)
    if (f.first && before !== undefined && Number(f.first) !== before + 1) {
      out.push(finding('act', Number(f.first) > before + 1
        ? `${f.prefix}: the day starts at ${f.first}, the previous history ended at ${before}: the numbers between were deleted or carry another date (the history phase names them)`
        : `${f.prefix}: the day starts at ${f.first}, at or below the previous history's last number ${before}: this day was pulled before`))
    }
  }
  if (p.secondary) out.push(finding('note', `${p.secondary} annulment(s) in the range (written as .fea.json, never imported as invoices)`))
  out.push(p.snapshot ? finding('ok', `snapshot: ${p.snapshot.products} products, ${p.snapshot.zero} at zero`) : unread('the snapshot line'))
  if (c.hasPos) {
    const pos = run('pull (POS receipts)', [pullScript, '--org', c.org, '--from', from, '--to', day, '--families', 'posReceipts', '--no-snapshot', ...serverArgs(c)], join(c.out, 'pull-pos.txt'))
    if (pos.code !== 0) out.push(finding('stop', `the POS pull failed (exit ${pos.code})`))
    else for (const k of parsePull(pos.text).pos) out.push(finding('ok', `${k.kind}: ${k.count} on ${k.days} day(s)`))
  }
  return out
}

/** Monthly chunks from the start of the org's history to the day: `<from>_<to>`. */
function chunkPlan(c: Ctx): [string, string][] {
  const out: [string, string][] = []
  let start = c.historyFrom
  while (start <= day) {
    const d = new Date(`${start}T00:00:00Z`)
    const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
    const end = monthEnd < day ? monthEnd : day
    out.push([start, end])
    const next = new Date(`${end}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1)
    start = next.toISOString().slice(0, 10)
  }
  return out
}

function history(c: Ctx): Finding[] {
  const out: Finding[] = []
  if (!has('no-pull')) {
    needServer(c)
    for (const [a, b] of chunkPlan(c)) {
      const name = `${a}_${b}`
      const r = run(`history ${name}`, [pullScript, '--org', c.org, '--from', a, '--to', b, '--no-snapshot', '--dest', join(c.ev, name, 'api'), ...serverArgs(c)], join(c.out, `hist-${name}.txt`))
      if (r.code === 3) return [finding('stop', 'the PlusMinus account is in use (exit 3). Never evict it.')]
      if (r.code !== 0) return [finding('stop', `the history pull of ${name} failed (exit ${r.code})`)]
    }
  }
  // A chunk's own GAPS line is no use here: a number dated in another month looks like a hole in this one.
  const gaps = numberGaps(chunkDirs(c.ev))
  if (gaps.length) out.push(finding('note', `numbers missing from the whole history (deleted in PlusMinus; the ones the previous report lists are known): ${gaps.map(g => `${g.family} ${g.missing.slice(0, 8).join(', ')}${g.missing.length > 8 ? ` … ${g.missing.length} in all` : ''}`).join('; ')}`))
  if (!c.prev) return [...out, finding('act', 'no previous history to diff against: pass --prev <evidence folder>')]
  const d = diffPulls(chunkDirs(c.prev), chunkDirs(c.ev))
  const outside = newOutsideDay(d, c.pulled)
  mkdirSync(c.out, { recursive: true })
  writeFileSync(join(c.out, 'doc-edits.txt'), [
    `old ${c.prev}`, `new ${c.ev}`,
    `compared ${d.compared} | same ${d.same} | changed ${d.changed.length} | only-old ${d.onlyOld.length} | only-new ${d.onlyNew.length}`,
    ...d.onlyOld.map(f => `ONLY-OLD ${f}`),
    ...d.changed.flatMap(ch => [`CHANGED ${ch.file} date ${ch.date}`, ...(ch.head ? [`   head: ${ch.head[0]}  →  ${ch.head[1]}`] : []), ...ch.removed.map(x => `   - ${x}`), ...ch.added.map(x => `   + ${x}`)]),
    ...outside.backdated.map(n => `NEW-OUTSIDE-THE-DAY ${n.file} date ${n.date}`),
    ...outside.notNew.map(f => `IN-THE-DAY-BUT-NOT-NEW ${f}`),
  ].join('\n') + '\n')
  return [...out, ...gateHistory(d, outside, period)]
}

function scan(c: Ctx): Finding[] {
  const s = scanDay(c.dayDir)
  mkdirSync(c.out, { recursive: true })
  writeFileSync(join(c.out, 'scan.txt'), [
    ...s.stock.map(d => `${d.file} lines ${d.lines} stores ${d.stores.join(' ')}${d.otherGroups.length ? ` groups ${d.otherGroups.join(',')}` : ''}`),
    ...s.invoices.noStock.map(n => `${n.file} БЕЗСКЛАД from ${n.from.join(',')}`),
    ...s.invoices.mixed.map(f => `${f} MIXED`),
    ...s.till.negative.map(n => `${n.file} negative ${n.quantity} ${n.item}`),
  ].join('\n') + '\n')
  return gateScan(s)
}

function predict(c: Ctx): Finding[] {
  loadSession()
  const snap = snapshotIn(c.pulled) ?? die(`no storeAvailability_*.json in ${c.pulled}: run pull first`)
  const chunks = chunkDirs(c.ev)
  if (!chunks.length) die(`no history chunks in ${c.ev}: run history first`)
  const out: Finding[] = []
  const audit = run('audit', ['run', 'scripts/audit-coverage-api.ts', '--org', c.org, '--dir', chunks.join(','), '--baseline', c.baseline, '--snapshot', snap], join(c.out, 'audit.txt'))
  out.push(...(audit.code === 0 ? gateAuditBefore(audit.text, c.baseline) : [finding('stop', `the audit failed (exit ${audit.code})`)]))
  const before = run('compare (before)', ['run', 'scripts/compare-stock-api.ts', '--org', c.org, '--dir', c.pulled], join(c.out, 'compare-before.txt'))
  out.push(...(before.code === 0 ? gateCompare(before.text, 'before') : [finding('stop', `the comparison failed (exit ${before.code})`)]))
  // The prediction nets the day's documents against the gap, so it only means something while they are unbooked.
  const a = audit.code === 0 ? parseAudit(audit.text, c.baseline) : null
  const booked = !!a?.invoices && !a.missingAfterBaseline.length && !a.postBaseline.length && a.tillDaysWithout?.length === 0
  if (booked) out.push(finding('note', 'nothing of the pulled range is left out of LGR: the day is booked already, so the prediction does not apply (the rerun phase proves it)'))
  else {
    const pred = run('predict', [join(skill, 'predict.ts'), '--org', c.org, '--dir', c.pulled, '--snapshot', snap, '--store', c.store, '--out', join(c.out, 'predict.tsv')], join(c.out, 'predict.txt'))
    out.push(...(pred.code === 0 ? gatePredict(pred.text) : [finding('stop', `the prediction failed (exit ${pred.code})`)]))
  }
  const prices = run('prices (before)', [join(skill, 'prices.ts'), 'snap', c.org, join(c.out, 'prices-pre.json')], join(c.out, 'prices-pre.txt'))
  out.push(prices.code === 0 ? finding('ok', 'price snapshot taken') : finding('stop', `the price snapshot failed (exit ${prices.code}): ${prices.text.trim().split('\n').at(-1) ?? ''}`))
  return out
}

const onlyArgs = (): string[] => (opt('only') ? ['--only', opt('only')!] : [])

function importerArgs(c: Ctx, family: Family, write: boolean): string[] {
  switch (family) {
    case 'receipts': return ['run', 'scripts/receive-stock-api.ts', '--dir', c.dayDir, '--org', c.org, ...onlyArgs(), ...(write ? ['--execute'] : [])]
    case 'transfers': return ['run', 'scripts/transfer-stock-api.ts', '--dir', c.dayDir, '--org', c.org, ...onlyArgs(), ...(write ? ['--execute'] : [])]
    case 'writeoffs': return ['run', 'scripts/adjust-stock-api.ts', '--dir', c.dayDir, '--org', c.org, ...onlyArgs(), ...(write ? ['--execute'] : [])]
    // ⚠ This importer WRITES unless told --dry-run. The account is a throwaway, so its name stays out of the document.
    case 'till': return ['run', 'scripts/import-cash-register-sales-api.ts', '--org', c.org, '--dir', c.dayDir, '--no-prepared-by', ...(opt('date') ? ['--date', opt('date')!] : []), ...(write ? [] : ['--dry-run'])]
    case 'invoices': return ['run', 'scripts/import-sales-invoices-api.ts', '--dir', c.dayDir, '--org', c.org, ...onlyArgs(), ...(write ? ['--convert'] : [])]
  }
}

function dry(c: Ctx, rerun: boolean): Finding[] {
  loadSession()
  const out: Finding[] = []
  for (const family of FAMILIES) {
    if (!present(c.dayDir, family)) continue
    // A selection (--dir, --only) keeps its own log beside the day's, never over it.
    const base = `${rerun ? 'rerun' : 'dry'}-${family}`
    const r = run(`${rerun ? 'rerun' : 'dry'} ${family}`, importerArgs(c, family, false), opt('dir') || opt('only') ? freeName(c.out, base) : join(c.out, `${base}.txt`))
    out.push(...gateDry(family, r.text, r.code, rerun))
  }
  if (!out.length) out.push(finding('act', `no importable file in ${c.dayDir}`))
  return out
}

function book(c: Ctx): Finding[] {
  loadSession()
  const family = opt('family') as Family | undefined
  if (!family || !FAMILIES.includes(family)) die(`book needs --family ${FAMILIES.join('|')}`)
  if (!present(c.dayDir, family)) return [finding('act', `no ${family} file in ${c.dayDir}`)]
  // The same selection, dry, right before the write: what was read is what is booked.
  const check = run(`dry ${family} (before booking)`, importerArgs(c, family, false), freeName(c.out, `book-check-${family}`))
  const before = gateDry(family, check.text, check.code, false)
  if (before.some(f => f.level === 'act' || f.level === 'stop')) return [...before, finding('stop', 'not booked: resolve what the dry run says first')]
  if (!has('execute')) return [...before, finding('note', 'dry only: add --execute to book this selection')]
  const done = run(`BOOK ${family}`, importerArgs(c, family, true), freeName(c.out, `run-${family}`))
  return gateBooked(family, done.text, done.code)
}

function after(c: Ctx): Finding[] {
  needServer(c)
  loadSession()
  const dest = join(c.ev, 'after', 'api')
  const p = run('pull (after)', [pullScript, '--org', c.org, '--from', from, '--to', day, '--dest', dest, ...serverArgs(c)], join(c.out, 'pull-after.txt'))
  if (p.code !== 0) return [finding('stop', `the pull after booking failed (exit ${p.code})`)]
  if (c.hasPos) {
    const pos = run('pull (after, POS)', [pullScript, '--org', c.org, '--from', from, '--to', day, '--families', 'posReceipts', '--no-snapshot', '--dest', dest, ...serverArgs(c)], join(c.out, 'pull-after-pos.txt'))
    if (pos.code !== 0) return [finding('stop', `the POS pull after booking failed (exit ${pos.code})`)]
  }
  const s = sameDay(c.pulled, dest)
  writeFileSync(join(c.out, 'same-day.txt'), [
    `documents: first ${s.first} | after ${s.after} | only first ${s.onlyFirst.length} | only after ${s.onlyAfter.length} | byte-different ${s.byteDifferent.length}`,
    ...s.onlyFirst.map(f => `- ${f}`), ...s.onlyAfter.map(f => `+ ${f}`), ...s.byteDifferent.map(f => `~ ${f}`),
    s.snapshot ? `snapshot: ${s.snapshot.rowsFirst} rows → ${s.snapshot.rowsAfter} rows | quantity changes ${s.snapshot.moved.length}` : 'snapshot: missing on one side',
    ...(s.snapshot?.moved ?? []).slice(0, 50).map(m => `  ${m.name}: ${m.from} → ${m.to}`),
  ].join('\n') + '\n')
  const cmp = run('compare (after)', ['run', 'scripts/compare-stock-api.ts', '--org', c.org, '--dir', dest], join(c.out, 'compare-after.txt'))
  return [...gateSameDay(s), ...(cmp.code === 0 ? gateCompare(cmp.text, 'after') : [finding('stop', `the comparison failed (exit ${cmp.code})`)])]
}

function prices(c: Ctx): Finding[] {
  loadSession()
  const pre = join(c.out, 'prices-pre.json')
  if (!existsSync(pre)) return [finding('stop', `no ${pre}: the snapshot before booking was not taken, so the price changes cannot be proven`)]
  const post = join(c.out, 'prices-post.json')
  const snap = run('prices (after)', [join(skill, 'prices.ts'), 'snap', c.org, post], join(c.out, 'prices-post.txt'))
  if (snap.code !== 0) return [finding('stop', `the price snapshot failed (exit ${snap.code})`)]
  const logs = readdirSync(c.out).filter(f => /^run-receipts(-\d+)?\.txt$/.test(f)).map(f => join(c.out, f))
  const d = run('price diff', [join(skill, 'prices.ts'), 'diff', pre, post, '--list', join(c.out, 'price-list.tsv'), ...logs], join(c.out, 'price-diff.txt'))
  return gatePrices(d.text, d.code)
}

function auditAfter(c: Ctx): Finding[] {
  loadSession()
  const snap = snapshotIn(join(c.ev, 'after', 'api')) ?? snapshotIn(c.pulled) ?? die('no snapshot: run pull (and after) first')
  const r = run('audit (after)', ['run', 'scripts/audit-coverage-api.ts', '--org', c.org, '--dir', chunkDirs(c.ev).join(','), '--baseline', c.baseline, '--snapshot', snap], join(c.out, 'audit-after.txt'))
  return r.code === 0 ? gateAuditAfter(r.text, c.baseline) : [finding('stop', `the audit failed (exit ${r.code})`)]
}

/** The day's figures, for the report: what the evidence says, in one place. */
function facts(c: Ctx): Finding[] {
  const lines: string[] = [`# ${c.org}, ${period}`, '']
  const t = (name: string) => read(join(c.out, name))
  const pulled = t('pull.txt'); if (pulled) for (const f of parsePull(pulled).families) lines.push(`- pulled ${f.prefix}: ${f.count}${f.first ? ` (${f.first}..${f.last})` : ''}`)
  const pos = t('pull-pos.txt'); if (pos) for (const k of parsePull(pos).pos) lines.push(`- pulled ${k.kind}: ${k.count}`)
  const edits = t('doc-edits.txt'); if (edits) lines.push(`- history: ${edits.split('\n')[2] ?? ''}`)
  const cb = t('compare-before.txt'), ca = t('compare-after.txt')
  if (cb && ca) lines.push(`- stock differences: ${parseCompare(cb).qtyDiffs} → ${parseCompare(ca).qtyDiffs}`)
  const pr = t('predict.txt'); if (pr) { const p = parsePredict(pr); lines.push(`- prediction: ${p.documents} documents, ${p.now} now, ${p.after} after`) }
  for (const f of existsSync(c.out) ? readdirSync(c.out).filter(n => /^run-.*\.txt$/.test(n)).sort() : []) {
    const text = t(f)!
    if (f.startsWith('run-receipts')) { const r = parseReceiptsLog(text); lines.push(`- ${f}: ${r.docs.length} document(s), movements ${r.docs.flatMap(d => d.movements).join(' ') || '-'}, created ${[...text.matchAll(/\+ created (\S+)/g)].map(m => m[1]).join(' ') || '-'}`) }
    else if (f.startsWith('run-transfers') || f.startsWith('run-writeoffs')) { const m = parseMovesLog(text); lines.push(`- ${f}: booked ${m.booked}, movements ${m.movements.join(' ') || '-'}`) }
    else if (f.startsWith('run-till')) for (const d of parseTillLog(text)) lines.push(`- ${f}: ${d.date} ${d.document ?? '-'}, ${d.items ?? '-'} lines, ${d.total ?? '-'} EUR booked, ${d.grossPaid ?? '-'} EUR taken`)
    else if (f.startsWith('run-invoices')) { const i = parseInvoicesLog(text); lines.push(`- ${f}: issued ${i.converted?.[0]} of ${i.converted?.[1]}, ${i.dispatches} dispatch(es), ${i.attached.length} attached to a till day (${i.attached.join(', ') || '-'}), ${i.newCustomers} new customer(s)`) }
  }
  const pd = t('price-diff.txt'); if (pd) { const p = parsePriceDiff(pd); lines.push(`- prices: ${p.changed} changed, ${p.unexplained} unexplained, ${p.protectedChanged.length} protected`) }
  const aa = t('audit-after.txt'); if (aa) { const a = parseAudit(aa, c.baseline); lines.push(`- audit after: ${a.missingAfterBaseline.length} invoices and ${a.postBaseline.length} stock documents unbooked past the baseline; till days missing: ${a.tillDaysWithout?.join(', ') || 'none'}`) }
  const last = lastNumbers(chunkDirs(c.ev)); lines.push(`- last numbers in this run's history: ${[...last].map(([k, n]) => `${k} ${n}`).join(', ') || '-'}`)
  mkdirSync(c.out, { recursive: true })
  writeFileSync(join(c.out, 'facts.md'), lines.join('\n') + '\n')
  console.log(lines.join('\n'))
  return [finding('ok', `written to ${join(c.out, 'facts.md')}`)]
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PHASES: Record<string, (c: Ctx) => Finding[] | Promise<Finding[]>> = {
  grant, pull, history, scan, predict, dry: c => dry(c, false), book, after, prices, rerun: c => dry(c, true), audit: auditAfter, facts,
}
if (!phase || has('help')) { console.log(readFileSync(import.meta.path, 'utf8').split('\n').slice(1, 35).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(phase ? 0 : 2) }
let findings: Finding[]
if (phase === 'plan') findings = plan()
else if (PHASES[phase]) findings = await PHASES[phase](context(opt('org') ?? die(`${phase} needs --org <slug>`)))
else die(`unknown phase "${phase}". Phases: plan, ${Object.keys(PHASES).join(', ')}`)

const LABEL = { ok: 'ok   ', note: 'note ', act: 'ACT  ', stop: 'STOP ' }
console.log(`\n── ${phase}${opt('org') ? ` ${opt('org')}` : ''} ──`)
for (const f of findings) {
  console.log(`${LABEL[f.level]} ${f.text}`)
  for (const d of (f.detail ?? []).slice(0, 15)) console.log(`        ${d}`)
  if ((f.detail?.length ?? 0) > 15) console.log(`        … ${f.detail!.length - 15} more in the log`)
}
const count = (l: Finding['level']) => findings.filter(f => f.level === l).length
console.log(`── ${count('stop')} STOP, ${count('act')} ACT, ${count('note')} note ──`)
process.exit(count('stop') ? 1 : 0)
