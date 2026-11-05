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
//                                Read from the file only: a person's own LGR_* in the environment is never used.
//   BOOKS_NIGHTLY_MAIL_TO        who hears about a change or a failure (comma-separated)
//   BOOKS_NIGHTLY_ORG            default regal-acc
//   BOOKS_NIGHTLY_YEARS          default 2025,2026. A later year in the archive is reported, never imported unattended: its first
//                                import opens the year, and a person looks at that
//   BOOKS_NIGHTLY_ROOT_ACCOUNTS  default СТОКИ=304,КЛИЕНТИ=411,ДОСТАВЧИЦИ=401
//   BOOKS_NIGHTLY_STALE_HOURS    default 72: no answer from the PC for this long is a failure. A weekend with the PC off is not.
// State and log, counts only: $ACC_DOCS_ROOT/books/nightly-state.json and nightly.log.
//
// Exit 0 when the run is fine (imported, nothing new, or the PC is off); 1 when it failed.
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { need, optional } from '../pull-plusminus-api/stores-env'
import { parseImport, problems, summarize, type YearResult } from '../../../scripts/lib/books-nightly-report'

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
const org = setting('BOOKS_NIGHTLY_ORG', 'regal-acc')
const years = setting('BOOKS_NIGHTLY_YEARS', '2025,2026').split(',').map(y => Number(y.trim())).sort((a, b) => a - b)
const rootAccounts = setting('BOOKS_NIGHTLY_ROOT_ACCOUNTS', 'СТОКИ=304,КЛИЕНТИ=411,ДОСТАВЧИЦИ=401').split(',').map(s => s.trim()).filter(Boolean)
const staleHours = Number(setting('BOOKS_NIGHTLY_STALE_HOURS', '72'))
const mailTo = setting('BOOKS_NIGHTLY_MAIL_TO').split(',').map(s => s.trim()).filter(Boolean)
// An empty LGR_TOKEN makes the importer sign in with these, whatever token the environment carries.
const creds = { LGR_USERNAME: file.LGR_USERNAME ?? '', LGR_PASSWORD: file.LGR_PASSWORD ?? '', LGR_TOKEN: '' }

const books = join(need('ACC_DOCS_ROOT'), 'books'), archives = join(need('ACC_DOCS_ROOT'), 'archives')
const stateFile = join(books, 'nightly-state.json'), logFile = join(books, 'nightly.log'), lockFile = join(books, 'nightly.lock')

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
 * distro holds it up for the run, and the run starts once the share answers. Unreadable after that, the run did not happen.
 */
async function holdDocsRoot(): Promise<{ readable: boolean; release: () => void }> {
  const readable = () => { try { readdirSync(books); return true } catch { return false } }
  const distro = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)/i.exec(books)?.[1]
  if (!distro) return { readable: readable(), release: () => {} }
  const holder = Bun.spawn(['wsl.exe', '-d', distro, '-e', 'sleep', '3600'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  for (let i = 0; i < 60 && !readable(); i++) await Bun.sleep(1000)
  return { readable: readable(), release: () => holder.kill() }
}

async function nightly(state: State): Promise<Outcome> {
  const newest = await newestArchive()
  if ('kind' in newest) return newest
  const { archive, sha12 } = newest
  if (!force && state.imported?.sha12 === sha12) return quiet(`${archive} is imported already`, true)

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
  for (const year of years) {
    const base = [process.execPath, join(repo, 'scripts', 'import-accounting-books.ts'), '--org', org, '--books', dir, '--year', String(year),
      ...rootAccounts.flatMap(r => ['--root-account', r]), '--finish']
    const first = await run(dry ? base : [...base, '--execute'], creds)
    if (first.code !== 0) return failed(`import ${year}`, tail(`${first.out}\n${first.err}`))
    const did = parseImport(first.out)
    const bad = problems(did)
    if (bad.length) return failed(`import ${year}`, bad.join('\n'))
    if (!dry) {
      const again = await run(base, creds)
      if (again.code !== 0) return failed(`dry rerun ${year}`, tail(`${again.out}\n${again.err}`))
      const rerun = summarize(year, parseImport(again.out))
      if (rerun.changes) return failed(`dry rerun ${year}`, `after the import, a dry rerun still reports changes: ${rerun.text}`)
    }
    results.push(summarize(year, did))
  }

  if (!dry) state.imported = { archive, sha12, at: now() }
  const changes = results.reduce((n, r) => n + r.changes, 0)
  const report = [
    `${org} from ${archive} (written ${meta.asOf}; the last operation in it is dated ${meta.span?.last ?? '?'})${dry ? ', DRY RUN' : ''}`,
    '',
    ...results.map(r => r.text),
    '',
    dry ? 'Nothing was written.' : 'A dry rerun of each year after the import reported everything unchanged.',
    ...(notices.length ? ['', ...notices] : []),
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
// The state, the log and the lock live there too: with it down, the run did not happen, and there is nothing to record it in.
const docsRoot = await holdDocsRoot()
if (!docsRoot.readable) { docsRoot.release(); console.log(`nightly: the docs root is unreadable (${books}); nothing ran`); process.exit(0) }
if (!takeLock()) { docsRoot.release(); console.log('nightly: another run holds the lock'); process.exit(0) }

const state: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
let outcome: Outcome
try {
  outcome = await nightly(state)
} catch (e: any) {
  outcome = failed('run', String(e?.stack ?? e))
}

const within = (iso: string | undefined, hours: number) => !!iso && Date.now() - Date.parse(iso) < hours * 3600_000
const mails: { subject: string; text: string }[] = []
try {
  if (!dry) {
    if (state.unsentMail) mails.push({ subject: `${state.unsentMail.subject} (unsent since ${state.unsentMail.at})`, text: state.unsentMail.text })
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
