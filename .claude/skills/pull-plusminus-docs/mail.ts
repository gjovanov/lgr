// Email a pulled PlusMinus day folder through SendGrid (the account LGR's own mail uses).
//
//   SENDGRID_API_KEY=… bun .claude/skills/pull-plusminus-docs/mail.ts --dir <day folder> [--to a@x,b@y] [--send]
//
// Without --send it only prints what it would send. Recipients come from --to, else from
// .secrets/plusminus-mail.json ({"to": [...], "from"?: "...", "fromName"?: "..."}), which is
// gitignored on purpose: this repo is public and the addresses are people's own.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const args = process.argv.slice(2)
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const dir = opt('--dir')
if (!dir || !existsSync(dir)) { console.error('mail.ts: --dir <day folder> is required'); process.exit(2) }

const cfgPath = join(import.meta.dir, '../../../.secrets/plusminus-mail.json')
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}
const to: string[] = (opt('--to')?.split(',') ?? cfg.to ?? []).map((s: string) => s.trim()).filter(Boolean)
if (!to.length) { console.error(`mail.ts: no recipients (--to, or "to" in ${cfgPath})`); process.exit(2) }
const from = { email: opt('--from') ?? cfg.from ?? 'noreply@lgrai.app', name: cfg.fromName ?? 'LGR · PlusMinus' }

const day = basename(dir.replace(/[\\/]+$/, ''))
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { console.error(`mail.ts: ${dir} is not a YYYY-MM-DD day folder`); process.exit(2) }

// The curated set pull.sh wrote; without it, every export-shaped file in the folder.
const exportName = /^((invoicem|invoiceProf|stokrazp|sklrazp|sklisk)_\d+\.pdf|(storeAvailability|salesAnalysis|storeOperations|docJournalReport)_\d{8}_\d{6}\.xlsx)$/
const manifest = join(dir, 'pull-manifest.txt')
const names = (existsSync(manifest)
  ? readFileSync(manifest, 'utf8').split('\n').map(l => l.split(' ')[0])
  : [...new Bun.Glob('*').scanSync(dir)]
).filter(n => exportName.test(n)).sort()
if (!names.length) { console.error(`mail.ts: nothing to send in ${dir}`); process.exit(3) }

const LABEL: Record<string, string> = {
  invoicem: 'Фактури', invoiceProf: 'Проформи', stokrazp: 'Стокови разписки',
  sklrazp: 'Складови разписки', sklisk: 'Искания (отписване)',
  salesAnalysis: 'Каса: анализ на продажбите', storeAvailability: 'Наличност',
  storeOperations: 'Складови операции', docJournalReport: 'Журнал на документите',
}
const byFam = new Map<string, string[]>()
for (const n of names) { const f = n.split('_')[0]; byFam.set(f, [...(byFam.get(f) ?? []), n]) }
const lines: string[] = []
for (const [fam, list] of byFam) {
  if (list[0].endsWith('.pdf')) {
    const nums = list.map(n => n.replace(/^\D+_|\.pdf$/g, ''))
    lines.push(`${LABEL[fam] ?? fam}: ${list.length} бр., № ${nums[0]}${nums.length > 1 ? ' – ' + nums[nums.length - 1] : ''}`)
  } else {
    for (const n of list) lines.push(`${LABEL[fam] ?? fam}: ${n}`)
  }
}
const [y, m, d] = day.split('-')
const bytes = names.reduce((s, n) => s + statSync(join(dir, n)).size, 0)
const subject = `PlusMinus експорт ${d}.${m}.${y} — РЕГАЛ ООД, СКЛАД - 1 (${names.length} файла)`
const body = [
  `Експорт от PlusMinus POS за ${d}.${m}.${y} — РЕГАЛ ООД, СКЛАД - 1 (Пазарджик).`, '',
  ...lines, '',
  `Общо ${names.length} файла (${(bytes / 1048576).toFixed(1)} MB), прикачени към писмото.`,
].join('\n')

console.log(`To:      ${to.join(', ')}\nFrom:    ${from.name} <${from.email}>\nSubject: ${subject}\n\n${body}\n`)
for (const n of names) console.log(`  attach  ${n}  ${statSync(join(dir, n)).size}`)
if (!args.includes('--send')) { console.log('\n(dry run: add --send to send)'); process.exit(0) }

const key = process.env.SENDGRID_API_KEY
if (!key?.startsWith('SG.')) { console.error('mail.ts: SENDGRID_API_KEY missing or not a SendGrid key'); process.exit(2) }
const type = (n: string) => n.endsWith('.pdf')
  ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const payload = {
  // One personalization per recipient: each gets their own copy and sees only their own address.
  personalizations: to.map(email => ({ to: [{ email }] })),
  from, subject,
  content: [{ type: 'text/plain', value: body }],
  attachments: names.map(n => ({
    filename: n, type: type(n), disposition: 'attachment',
    content: readFileSync(join(dir, n)).toString('base64'),
  })),
}
const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
// 202 = accepted for delivery; the message id is what SendGrid's activity feed searches by.
console.log(`\nSendGrid: ${res.status} ${res.statusText}  message-id=${res.headers.get('x-message-id') ?? '-'}`)
if (res.status !== 202) { console.error(await res.text()); process.exit(1) }
