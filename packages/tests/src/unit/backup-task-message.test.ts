import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createI18nPlugin } from 'ui-shared/plugins/i18n'
import { backupTaskMessage } from '../../../portal-ui/src/views/admin/backup-task-message'

/**
 * #772: while a backup is being made, the line under the progress bar says what the run is doing in the page's
 * language. It was the task's last log line as the server wrote it, so a Bulgarian screen read "Verifying" and "Done".
 *
 * The task now carries a stage code beside its log lines, and the page translates the code. The log line is what it
 * falls back to: for a task with no code, for a code the catalogue has no name for, and for a failed task, whose stage
 * only says where it stopped.
 *
 * That the server really sends these codes, and that each has a name in every catalogue, is held by a real run in
 * `integration/backup-restore.flow.test.ts`.
 */

const PACKAGES = join(import.meta.dir, '..', '..', '..')
const LOCALES = ['en', 'bg', 'de', 'mk'] as const
const catalogue = (locale: string) => JSON.parse(readFileSync(join(PACKAGES, 'ui-shared', 'src', 'locales', `${locale}.json`), 'utf8'))

/** The stages a run reports, with the log line the server writes beside each. */
const STAGES: Array<[code: string, line: string]> = [
  ['exporting', 'Exporting collections'],
  ['packing', 'Packing documents'],
  ['verifying', 'Verifying'],
  ['done', 'Done'],
]

describe('the line about a backup being made (#772)', () => {
  // A catalogue that knows one stage, and marks what it translated.
  const names: Record<string, string> = { 'backup.stage.verifying': '‹verifying›' }
  const t = (key: string) => names[key] ?? key
  const te = (key: string) => key in names

  it('says a stage it knows in the page\'s language, whatever the log line reads', () => {
    expect(backupTaskMessage({ status: 'processing', stage: 'verifying', logs: ['Job started: backup-create', 'Verifying'] }, t, te))
      .toBe('‹verifying›')
  })

  it('shows the log line for a code it has no name for, never the key', () => {
    expect(backupTaskMessage({ status: 'processing', stage: 'uploading', logs: ['Job started: backup-create', 'Uploading off-site'] }, t, te))
      .toBe('Uploading off-site')
  })

  it('shows the log line of a task that carries no code', () => {
    expect(backupTaskMessage({ status: 'processing', logs: ['Job started: backup-create', 'Verifying'] }, t, te)).toBe('Verifying')
    expect(backupTaskMessage({ status: 'processing', stage: '', logs: ['Verifying'] }, t, te)).toBe('Verifying')
  })

  it('is empty with no code and no log line', () => {
    expect(backupTaskMessage({ status: 'processing', logs: [] }, t, te)).toBe('')
    expect(backupTaskMessage({ status: 'processing' }, t, te)).toBe('')
    expect(backupTaskMessage({}, t, te)).toBe('')
    expect(backupTaskMessage(null, t, te)).toBe('')
    expect(backupTaskMessage(undefined, t, te)).toBe('')
  })

  it('shows the last log line, which is the newest', () => {
    expect(backupTaskMessage({ logs: ['Job started: backup-create', 'Exporting collections', 'Verifying'] }, t, te)).toBe('Verifying')
  })

  it('a failed task says why it failed, not the stage it stopped in', () => {
    // The stage of a failed run is where it stopped. Shown as it is, the page would go on saying "Verifying" under a
    // backup that is over.
    const failed = { status: 'failed', stage: 'verifying', logs: ['Verifying', 'Job failed: bundle failed its own verification'] }
    expect(backupTaskMessage(failed, t, te)).toBe('Job failed: bundle failed its own verification')
  })
})

describe('the same line, said by the app\'s own translator from the real catalogues', () => {
  /** `t` and `te` as the view gets them from `useI18n()`, with one language loaded. */
  function translator(locale: string) {
    const global = createI18nPlugin().global as any
    global.setLocaleMessage(locale, catalogue(locale))
    global.locale.value = locale
    return { t: global.t as (key: string) => string, te: global.te as (key: string) => boolean }
  }

  it('names every stage in all four languages', () => {
    for (const locale of LOCALES) {
      const { t, te } = translator(locale)
      const names = catalogue(locale).backup.stage
      for (const [code, line] of STAGES) {
        const said = backupTaskMessage({ status: 'processing', stage: code, logs: [line] }, t, te)
        expect({ locale, code, said }).toEqual({ locale, code, said: names[code] })
        expect({ locale, code, empty: !String(said).trim() }).toEqual({ locale, code, empty: false })
        // What the issue was: every language but English read the server's English line.
        if (locale !== 'en') expect({ locale, code, english: said === line }).toEqual({ locale, code, english: false })
      }
    }
  })

  it('a finished backup reads "done" in the page\'s language, though its last log line is the task\'s own', () => {
    const { t, te } = translator('bg')
    const finished = { status: 'completed', stage: 'done', logs: ['Verifying', 'Done', 'Job completed successfully'] }
    expect(backupTaskMessage(finished, t, te)).toBe(catalogue('bg').backup.stage.done)
  })

  it('falls back to the log line for a code no catalogue names, and for a word every object answers to', () => {
    for (const locale of LOCALES) {
      const { t, te } = translator(locale)
      for (const code of ['uploading', 'constructor', 'toString', '__proto__', 'done.x']) {
        const said = backupTaskMessage({ status: 'processing', stage: code, logs: ['The log line'] }, t, te)
        expect({ locale, code, said }).toEqual({ locale, code, said: 'The log line' })
      }
    }
  })

  it('the catalogues hold the page\'s other two sentences, with the verify line\'s file and count', () => {
    for (const locale of LOCALES) {
      const { t } = translator(locale) as { t: (key: string, named?: Record<string, unknown>) => string }
      const backup = catalogue(locale).backup
      expect({ locale, failed: typeof backup.createFailed }).toEqual({ locale, failed: 'string' })
      expect(backup.verifyOk).toContain('{file}')
      expect(backup.verifyOk).toContain('{n}')
      const line = t('backup.verifyOk', { file: 'lgr-acme-full-2026-11-19.ndjson.zst', n: 5123 })
      expect(line.startsWith('lgr-acme-full-2026-11-19.ndjson.zst: ')).toBe(true)
      expect(line).toContain('5123')
      expect(line).not.toContain('{')
    }
  })
})

describe('the backup page words nothing itself (#772)', () => {
  const view = readFileSync(join(PACKAGES, 'portal-ui', 'src', 'views', 'admin', 'BackupView.vue'), 'utf8')

  it('takes the line about the task from the rule above', () => {
    expect(view).toContain('backupTaskMessage(task, t, te)')
    // What it used to do: the task's last log line, as it came.
    expect(/taskMessage\.value\s*=\s*\([^)]*\.logs/.test(view)).toBe(false)
  })

  it('holds neither English sentence it used to', () => {
    expect(view).not.toContain('The backup failed')
    expect(view).not.toContain('documents)')
    expect(view).toContain("t('backup.createFailed')")
    expect(view).toContain("t('backup.verifyOk', {")
  })
})
