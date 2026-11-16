#!/usr/bin/env bun
// nightly.ts — the unattended books run (FR-25, until go-live): the books PC's newest archive into the books org, the BOOKS only.
// It mails only when something changed or went wrong; a run with nothing new is silent. Payroll and VAT stay runs by hand after
// each filing (SKILL.md, "Import"): which months are filed is a person's to say.
//
//   bun nightly.ts           fetch-archive → pull-books --no-payroll → each year imported with --execute, then a dry rerun that
//                            must report everything unchanged
//   bun nightly.ts --dry     the imports as dry runs: nothing written in LGR, nothing mailed, the state left as it was
//   bun nightly.ts --force   also when the newest archive was imported already
//   bun nightly.ts --local   the newest archive already fetched, without asking the PC (a re-run after a failure, or a test)
//   bun nightly.ts --check-mail   one request in SendGrid's sandbox mode: proves the key, the sender and the recipients, and
//                            delivers nothing
//
// Settings, NAME=value lines in BOOKS_NIGHTLY_ENV (default: the main checkout's .secrets/lgr-books-sync.env):
//   LGR_USERNAME, LGR_PASSWORD   the books org's service account, whose only right is accounting.import (seed-user --permissions).
//                                Read from the file only: a person's own LGR_* in the environment is never used. For a split, the
//                                same person with a membership in every org of it, each holding only accounting.import
//   BOOKS_NIGHTLY_MAIL_TO        who hears about a change or a failure (comma-separated)
//   BOOKS_NIGHTLY_ORGS           FR-25 R7, books split over a group: EVERY org of it, comma-separated. Each is sent the same files and
//                                keeps its share; the run checks that the shares add up to the file and that each year opens where the
//                                one before closed (from the archive: no single org can say). Unset: BOOKS_NIGHTLY_ORG alone, as before
//   BOOKS_NIGHTLY_ORG            default regal-acc
//   BOOKS_NIGHTLY_YEARS          default 2025,2026. A later year in the archive is reported, never imported unattended: its first
//                                import opens the year, and a person looks at that
//   BOOKS_NIGHTLY_ROOT_ACCOUNTS  default СТОКИ=304,КЛИЕНТИ=411,ДОСТАВЧИЦИ=401
//   BOOKS_NIGHTLY_STALE_HOURS    default 72: no answer from the PC for this long is a failure. A weekend with the PC off is not.
//   BOOKS_NIGHTLY_DOWN_HOURS     default 6: the docs root not answering for this long is mailed, then once a day while it lasts
// State and log, counts only: $ACC_DOCS_ROOT/books/nightly-state.json and nightly.log. Since when the docs root has not
// answered is kept on this PC instead, in %LOCALAPPDATA%\lgr-books-nightly\docs-root.json: the share cannot say it is down.
// The documents of the last import, by importKey, in books/nightly-documents.json.gz: the next import's mail lists the
// documents it changed by date, type and number (no name, no amount), and keeps the whole list in books/<day>/changes-<sha>.txt.
//
// Exit 0 when the run is fine (imported, nothing new, or the PC is off); 1 when it failed or the docs root did not answer.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { need, optional } from '../pull-plusminus-api/stores-env'
import {
  continuityOfFiles,
  docsRootDown,
  documentChanges,
  documentChangesText,
  importedDocuments,
  isSplitImport,
  listsWithin,
  orgsOf,
  parseImport,
  parseImported,
  problems,
  serializeImported,
  splitProblems,
  summarize,
  summarizeOrgs,
  type DocsRootDown,
  type ImportedDocuments,
  type ImportedDocumentsFile,
  type OrgImport,
  type YearResult,
} from '../../../scripts/lib/books-nightly-report'

const here = import.meta.dir
const repo = resolve(here, '../../..')
const args = process.argv.slice(2)
const dry = args.includes('--dry'), force = args.includes('--force'), local = args.includes('--local')

function mainCheckout(): string {
  const r = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here, stdout: 'pipe', stderr: 'ignore' })
  const common = r.stdout.toString().trim()
  return r.exitCode === 0 && common ? dirname(common) : repo
}

function envFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

const settingsFile = process.env.BOOKS_NIGHTLY_ENV ?? join(mainCheckout(), '.secrets', 'lgr-books-sync.env')
const file = envFile(settingsFile)
const setting = (name: string, fallback = '') => process.env[name] || file[name] || fallback
const orgs = orgsOf(setting('BOOKS_NIGHTLY_ORGS'), setting('BOOKS_NIGHTLY_ORG', 'regal-acc'))
/** What the mails and the log call the run: the one org, or every org of a split. */
const org = orgs.join('+')
const years = setting('BOOKS_NIGHTLY_YEARS', '2025,2026').split(',').map(y => Number(y.trim())).sort((a, b) => a - b)
const rootAccounts = setting('BOOKS_NIGHTLY_ROOT_ACCOUNTS', 'СТОКИ=304,КЛИЕНТИ=411,ДОСТАВЧИЦИ=401').split(',').map(s => s.trim()).filter(Boolean)
const staleHours = Number(setting('BOOKS_NIGHTLY_STALE_HOURS', '72'))
const downHours = Number(setting('BOOKS_NIGHTLY_DOWN_HOURS', '6'))
const mailTo = setting('BOOKS_NIGHTLY_MAIL_TO').split(',').map(s => s.trim()).filter(Boolean)
// An empty LGR_TOKEN makes the importer sign in with these, whatever token the environment carries.
const creds = { LGR_USERNAME: file.LGR_USERNAME ?? '', LGR_PASSWORD: file.LGR_PASSWORD ?? '', LGR_TOKEN: '' }

const books = join(need('ACC_DOCS_ROOT'), 'books'), archives = join(need('ACC_DOCS_ROOT'), 'archives')
const stateFile = join(books, 'nightly-state.json'), logFile = join(books, 'nightly.log'), lockFile = join(books, 'nightly.lock')
const documentsFile = join(books, 'nightly-documents.json.gz')
/** The lines of the document list a mail carries. The day folder's changes file has them all. */
const MAIL_LIST_LINES = 60
const downFile = join(process.env.LOCALAPPDATA || homedir(), 'lgr-books-nightly', 'docs-root.json')

type State = {
  imported?: { archive: string; sha12: string; at: string }
  /** The last run the PC answered and nothing failed: an import, or nothing new. */
  lastOkAt?: string
  lastFailure?: { at: string; step: string; mailedAt?: string }
  staleMailedAt?: string
  unsentMail?: { subject: string; text: string; at: string }
}
type Outcome =
  | { kind: 'quiet'; note: string; answered: boolean }
  | { kind: 'imported'; note: string; report: string; subject: string; worthMail: boolean }
  | { kind: 'failed'; step: string; detail: string }

const now = () => new Date().toISOString()
const within = (iso: string | undefined, hours: number) => !!iso && Date.now() - Date.parse(iso) < hours * 3600_000
const tail = (s: string, n = 25) => s.trim().split('\n').slice(-n).join('\n')
const quiet = (note: string, answered: boolean): Outcome => ({ kind: 'quiet', note, answered })
const failed = (step: string, detail: string): Outcome => ({ kind: 'failed', step, detail })

async function run(cmd: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { cwd: repo, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out: out.replace(/\r/g, ''), err: err.replace(/\r/g, ''), code }
}

/** The archive to import, and its SHA-256's first 12 hex digits as fetch-archive prints them. */
async function newestArchive(): Promise<{ archive: string; sha12: string } | Outcome> {
  if (local) {
    const fetched = readdirSync(archives).filter(f => /^\d{8}\.arz\.sealed$/.test(f)).sort()
    if (!fetched.length) return failed('local', `no fetched archive in ${archives}`)
    const name = fetched[fetched.length - 1]
    return { archive: name.replace(/\.sealed$/, ''), sha12: readFileSync(join(archives, `${name}.sha`), 'utf8').trim().slice(0, 12).toUpperCase() }
  }
  const fetched = await run([process.execPath, join(here, 'fetch-archive.ts')])
  if (fetched.code === 2) return quiet('no complete archive on the PC yet', true)
  // Only an unreachable PC is quiet (it is off at night and at weekends); anything else fetch-archive throws is a failure.
  if (fetched.code !== 0 && /roomler ssh kept failing/.test(fetched.err)) return quiet('the books PC did not answer', false)
  if (fetched.code !== 0) return failed('fetch-archive', tail(fetched.err || fetched.out))
  const m = /^(same|fetched)\s+(\d{8}\.arz)\s+\d+\s+([0-9A-F]{12})/m.exec(fetched.out)
  if (!m) return failed('fetch-archive', tail(fetched.out + fetched.err))
  return { archive: m[2], sha12: m[3] }
}

/**
 * The docs root may be a WSL share (`\\wsl.localhost\<distro>\…`), which lives only while that distro runs. WSL stops an
 * idle distro within seconds, and a read that lands while it starts or stops fails ("Invalid request code", ECANCELED:
 * 2026-11-05, after a job inside WSL ran the VM out of memory and nothing kept the distro up). So a `sleep` inside the
 * distro holds it up for the run, and the run starts once the share answers. A STUCK distro does not fail a read, it hangs
 * it (the same day, 22:52 to 23:00 UTC), so this process never reads the share before a child has listed it (`listsWithin`).
 * Not listed within 90 s, the run did not happen.
 */
async function holdDocsRoot(): Promise<{ readable: boolean; release: () => void }> {
  const distro = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)/i.exec(books)?.[1]
  const holder = distro ? Bun.spawn(['wsl.exe', '-d', distro, '-e', 'sleep', '3600'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }) : null
  const until = Date.now() + 90_000
  let readable = await listsWithin(books, 10_000)
  while (!readable && Date.now() < until) {
    await Bun.sleep(2000)
    readable = await listsWithin(books, 10_000)
  }
  return { readable, release: () => holder?.kill() }
}

/**
 * §5.3 for a split (FR-25 R7), from the books folder: the year before's stored openings and journal against this year's
 * stored openings. The importer's own check reads what the books org imported, and a share is not the company's.
 */
function splitContinuity(dir: string, year: number) {
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
  const openingOf = (chart: any) => (chart.rows ?? []).map((r: any) => ({ code: r.code, debit: r.openingDebit ?? 0, credit: r.openingCredit ?? 0 }))
  const before = { opening: openingOf(read(`chart-${year - 1}.json`)), documents: read(`journal-${year - 1}.json`).documents ?? [] }
  return continuityOfFiles(year, before, openingOf(read(`chart-${year}.json`)))
}

/** Every configured year's journal in a books folder, as the importer keys its documents. */
function journalsIn(dir: string): ImportedDocuments {
  const all: ImportedDocuments = new Map()
  for (const year of years) {
    for (const [key, doc] of importedDocuments(JSON.parse(readFileSync(join(dir, `journal-${year}.json`), 'utf8')).documents)) all.set(key, doc)
  }
  return all
}

/**
 * The documents the last import wrote: the file this run keeps, or else that import's own books folder while it still
 * holds that archive. Nothing when neither is that import's (the list is a convenience: it never fails a run).
 */
function documentsImportedBefore(state: State): ImportedDocumentsFile | undefined {
  const last = state.imported
  if (!last) return undefined
  try {
    const kept = existsSync(documentsFile) ? parseImported(readFileSync(documentsFile)) : undefined
    if (kept?.sha12 === last.sha12) return kept
    const dir = join(books, last.archive.slice(0, 8))
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    if (String(meta.archiveSha256 ?? '').slice(0, 12).toUpperCase() !== last.sha12) return undefined
    return { ...last, documents: journalsIn(dir) }
  } catch {
    return undefined
  }
}

/**
 * This import's documents, kept for the next run to compare with, and the ones that differ from the last import's: all of
 * them into the day folder, the first lines into the mail. A dry run writes neither and prints the whole list.
 */
function listDocuments(before: ImportedDocumentsFile | undefined, current: Omit<ImportedDocumentsFile, 'documents'>, dir: string): string[] {
  try {
    const after = journalsIn(dir)
    if (!dry) writeFileSync(documentsFile, serializeImported({ ...current, documents: after }))
    if (!before) return ['No record of the documents imported before this run, so they are not listed. The next import lists them.']
    const lines = documentChangesText(documentChanges(before.documents, after))
    if (!lines.length) return []
    const head = `By document, against ${before.archive} (imported ${before.at}): date, type and number, no names or amounts.`
    if (dry) return [head, ...lines]
    const file = join(dir, `changes-${current.sha12}.txt`)
    writeFileSync(file, [head, ...lines].join('\n') + '\n')
    const more = lines.length - MAIL_LIST_LINES
    return [head, ...lines.slice(0, MAIL_LIST_LINES), ...(more > 0 ? [`… and ${more} more lines in ${file}`] : [])]
  } catch (e: any) {
    return [`The documents could not be listed: ${String(e?.message ?? e)}`]
  }
}

async function nightly(state: State): Promise<Outcome> {
  const newest = await newestArchive()
  if ('kind' in newest) return newest
  const { archive, sha12 } = newest
  if (!force && state.imported?.sha12 === sha12) return quiet(`${archive} is imported already`, true)

  // Read before pull-books: a second archive of the same day is pulled into the same folder, over the first one's files.
  const before = documentsImportedBefore(state)
  const pulled = await run([process.execPath, join(here, 'pull-books.ts'), '--archive', join(archives, `${archive}.sealed`), '--years', years.join(','), '--no-payroll'])
  if (pulled.code !== 0) return failed('pull-books', tail(pulled.err || pulled.out))
  const dir = join(books, archive.slice(0, 8))
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  const notices: string[] = []
  const lastYear = Number(String(meta.span?.last ?? '').slice(0, 4))
  if (lastYear > Math.max(...years)) {
    notices.push(`The archive has operations in ${lastYear}, which BOOKS_NIGHTLY_YEARS (${years.join(',')}) does not import. Import that year by hand once, then add it.`)
  }

  const results: YearResult[] = []
  // A failure stops that org's later years, never another org's: each is sent the whole archive, and what one wrote
  // is reported beside what stopped the other (FR-25 R7). With one org this is the run it always was.
  const failures: { org: string; step: string; detail: string }[] = []
  const stopped = new Set<string>()
  const fail = (o: string, step: string, detail: string) => { failures.push({ org: o, step, detail }); stopped.add(o) }
  for (const year of years) {
    const done: OrgImport[] = []
    for (const o of orgs) {
      if (stopped.has(o)) continue
      const base = [process.execPath, join(repo, 'scripts', 'import-accounting-books.ts'), '--org', o, '--books', dir, '--year', String(year),
        ...rootAccounts.flatMap(r => ['--root-account', r]), '--finish']
      const first = await run(dry ? base : [...base, '--execute'], creds)
      if (first.code !== 0) { fail(o, `import ${year}`, tail(`${first.out}\n${first.err}`)); continue }
      const did = parseImport(first.out)
      const bad = problems(did)
      if (bad.length) { fail(o, `import ${year}`, bad.join('\n')); continue }
      if (!dry) {
        const again = await run(base, creds)
        if (again.code !== 0) { fail(o, `dry rerun ${year}`, tail(`${again.out}\n${again.err}`)); continue }
        const rerun = summarize(year, parseImport(again.out))
        if (rerun.changes) { fail(o, `dry rerun ${year}`, `after the import, a dry rerun still reports changes: ${rerun.text}`); continue }
      }
      done.push({ org: o, parsed: did })
    }
    if (!done.length) continue
    results.push(summarizeOrgs(year, done))
    // The group as a whole, which no one org of a split can see: shares that add up, and the year opening where the last closed.
    if (done.length === orgs.length && done.some(d => isSplitImport(d.parsed))) {
      const group = splitProblems(year, done)
      const continuity = years.includes(year - 1) ? splitContinuity(dir, year) : null
      if (continuity?.differing.length) group.push(`opening ${year}: continuity differs on ${continuity.differing.length} accounts (${continuity.differing.join(', ')})`)
      if (group.length) fail(org, `the split ${year}`, group.join('\n'))
    }
  }

  if (failures.length) {
    // One org: exactly the failure it always mailed. Several: each named, and what the others did beside it.
    if (orgs.length === 1) return failed(failures[0].step, failures[0].detail)
    return failed(
      failures.map(f => `${f.step} (${f.org})`).join('; '),
      [...failures.map(f => `${f.org}, ${f.step}:\n${f.detail}`), '', 'The rest of the run, counts only:', ...results.map(r => r.text)].join('\n'),
    )
  }

  if (!dry) state.imported = { archive, sha12, at: now() }
  const changes = results.reduce((n, r) => n + r.changes, 0)
  const listed = listDocuments(before, { archive, sha12, at: state.imported?.at ?? now() }, dir)
  const report = [
    `${org} from ${archive} (written ${meta.asOf}; the last operation in it is dated ${meta.span?.last ?? '?'})${dry ? ', DRY RUN' : ''}`,
    '',
    ...results.map(r => r.text),
    '',
    dry ? 'Nothing was written.' : 'A dry rerun of each year after the import reported everything unchanged.',
    ...(notices.length ? ['', ...notices] : []),
    ...(listed.length ? ['', ...listed] : []),
  ].join('\n')
  return {
    kind: 'imported',
    note: `${archive}: ${changes} change(s)${notices.length ? `, ${notices.length} notice(s)` : ''}`,
    report,
    subject: `LGR books: ${org} ${meta.asOf}: ${changes} change(s)`,
    worthMail: changes > 0 || notices.length > 0,
  }
}

async function sendMail(subject: string, text: string, sandbox = false): Promise<boolean> {
  if (!mailTo.length) return false
  let key = process.env.SENDGRID_API_KEY ?? ''
  const keyFile = optional('EMAIL_KEY_ENV_FILE')
  if (!key && keyFile) {
    // The key LGR's own mail uses, on mars (memory lgr-sendgrid-email-ops), as the invoice-mail skill reads it. Never printed.
    const r = Bun.spawnSync(['roomler', 'ssh', 'mars', '--', `grep -m1 '^EMAIL_API_KEY=' ${keyFile} | cut -d= -f2- | tr -d '"\\r'`], { stdout: 'pipe', stderr: 'ignore', timeout: 120_000 })
    key = r.stdout.toString().trim()
  }
  if (!key.startsWith('SG.')) return false
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: mailTo.map(email => ({ email })) }],
      from: { email: 'noreply@lgrai.app', name: 'LGR · books nightly' },
      subject,
      content: [{ type: 'text/plain', value: `${text}\n\n— .claude/skills/pull-plusminus-books/nightly.ts` }],
      ...(sandbox ? { mail_settings: { sandbox_mode: { enable: true } } } : {}),
    }),
  })
  return res.ok
}

function takeLock(): boolean {
  try {
    const fd = openSync(lockFile, 'wx')
    writeFileSync(fd, `${process.pid} ${now()}\n`)
    closeSync(fd)
    return true
  } catch {
    try {
      // A run is capped at an hour by the task; a lock this old is a crashed run's.
      if (Date.now() - statSync(lockFile).mtimeMs > 2 * 3600_000) { unlinkSync(lockFile); return takeLock() }
    } catch { /* gone in between, or unreadable: leave it */ }
    return false
  }
}

if (!creds.LGR_USERNAME || !creds.LGR_PASSWORD) { console.error(`nightly: no LGR_USERNAME/LGR_PASSWORD in ${settingsFile}`); process.exit(1) }
if (!dry && !mailTo.length) { console.error(`nightly: no BOOKS_NIGHTLY_MAIL_TO in ${settingsFile}: a failure would go unseen`); process.exit(1) }
if (args.includes('--check-mail')) {
  const ok = await sendMail('LGR books: sandbox check', 'Not delivered: SendGrid sandbox mode.', true).catch(() => false)
  console.log(`nightly: mail ${ok ? 'accepted by SendGrid (sandbox, not delivered)' : 'REFUSED or no key'} for ${mailTo.length} recipient(s)`)
  process.exit(ok ? 0 : 1)
}
// The state, the log and the lock live there too, so with it down the run did not happen and they cannot say so. `downFile`,
// on this PC, keeps since when; a WSL that stays broken would otherwise stop the import without a word to anyone.
const docsRoot = await holdDocsRoot()
let wasDown: DocsRootDown | undefined
try { wasDown = JSON.parse(readFileSync(downFile, 'utf8')) } catch { /* the root answered last time */ }
if (!docsRoot.readable) {
  docsRoot.release()
  const { down, hours, mail } = docsRootDown(wasDown, now(), downHours)
  if (!dry) {
    const text = `${books} has not answered since ${down.since}, so no run has happened since then. The task asks every two hours, and this mail repeats once a day while it lasts.`
    if (mail && (await sendMail(`LGR books: ${org}: the docs root has not answered for ${Math.round(hours)} h`, text).catch(() => false))) down.mailedAt = now()
    try { mkdirSync(dirname(downFile), { recursive: true }); writeFileSync(downFile, JSON.stringify(down) + '\n') } catch { /* the next run counts from itself */ }
  }
  console.log(`nightly: the docs root does not answer (${books}), since ${down.since}; nothing ran`)
  process.exit(1)
}
if (!takeLock()) { docsRoot.release(); console.log('nightly: another run holds the lock'); process.exit(0) }
// Answering again: forget the outage, and when it was mailed, say that it is over.
const backAfter = !dry ? wasDown : undefined
if (backAfter) try { unlinkSync(downFile) } catch { /* gone already */ }

const state: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
let outcome: Outcome
try {
  outcome = await nightly(state)
} catch (e: any) {
  outcome = failed('run', String(e?.stack ?? e))
}

const mails: { subject: string; text: string }[] = []
try {
  if (!dry) {
    if (state.unsentMail) mails.push({ subject: `${state.unsentMail.subject} (unsent since ${state.unsentMail.at})`, text: state.unsentMail.text })
    if (backAfter?.mailedAt) mails.push({ subject: `LGR books: ${org}: the docs root answers again`, text: `It did not answer from ${backAfter.since} until this run.` })
    if (outcome.kind === 'failed') {
      // The task retries every two hours: the same failure is mailed once a day, a different one at once.
      const repeat = state.lastFailure?.step === outcome.step && within(state.lastFailure.mailedAt, 24)
      state.lastFailure = { at: now(), step: outcome.step, mailedAt: repeat ? state.lastFailure!.mailedAt : now() }
      if (!repeat) mails.push({ subject: `LGR books: ${org} FAILED at ${outcome.step}`, text: `${outcome.detail}\n\nNothing after this step ran. The next run retries the whole archive.` })
    } else if (outcome.kind === 'imported' || outcome.answered) {
      state.lastOkAt = now()
      delete state.lastFailure
    }
    if (outcome.kind === 'imported' && outcome.worthMail) mails.push({ subject: outcome.subject, text: outcome.report })
    const silentHours = (Date.now() - Date.parse(state.lastOkAt ?? state.imported?.at ?? now())) / 3600_000
    if (outcome.kind === 'quiet' && !outcome.answered && silentHours > staleHours && !within(state.staleMailedAt, 24)) {
      state.staleMailedAt = now()
      mails.push({ subject: `LGR books: ${org}: no answer from the books PC for ${Math.round(silentHours)} h`, text: `The last run that reached the PC was at ${state.lastOkAt ?? '(never)'}.\nThis run: ${outcome.note}` })
    }
    delete state.unsentMail
    for (const mail of mails) {
      if (!(await sendMail(mail.subject, mail.text).catch(() => false))) state.unsentMail = { ...mail, at: now() }
    }
    writeFileSync(stateFile, JSON.stringify(state, null, 1) + '\n')
  }
  const line = outcome.kind === 'failed' ? `FAILED at ${outcome.step}` : outcome.note
  try { appendFileSync(logFile, `${now()} ${dry ? '[dry] ' : ''}${line}${mails.length ? ` (mailed ${mails.length}${state.unsentMail ? ', one UNSENT' : ''})` : ''}\n`) } catch { /* the log is a convenience */ }
  console.log(outcome.kind === 'failed' ? `nightly: FAILED at ${outcome.step}\n${outcome.detail}` : `nightly: ${outcome.note}`)
  if (outcome.kind === 'imported' && (dry || outcome.worthMail)) console.log(`\n${outcome.report}`)
} finally {
  try { unlinkSync(lockFile) } catch { /* already gone */ }
  docsRoot.release()
}
process.exit(outcome.kind === 'failed' ? 1 : 0)
