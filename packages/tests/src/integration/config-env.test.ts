import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The falsy-zero class of configuration bug.
 *
 * `Number(process.env.X) || fallback` cannot express a zero. `Number('0')` is `0`, which is
 * falsy, so the one value that turns a threshold off is the one value that silently becomes
 * the default. The setting looks applied, behaves as unset, and reports nothing either way —
 * which is why it survived in three places until somebody tried to use one.
 *
 * ⚠ This is a SOURCE test rather than a behavioural one, and deliberately so. `config` reads
 * `process.env` once at module load, so a test cannot re-read it with different values
 * without module-registry surgery that would be more fragile than the thing under test. What
 * actually needs guarding is the shape of the expression, and that is right here in the file.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const SRC = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'config', 'src', 'index.ts'),
  'utf8',
)

/**
 * Settings whose ZERO means something, and what it means. Each must go through `numEnv`.
 *
 * ⚠ Deliberately not "every numeric setting". Most are intervals, sizes and counts where
 * zero is nonsense or harmful — `SUPTO_TIME_SYNC_INTERVAL_MS=0` would spin a `setInterval`
 * hot — and those keep `||` so a stray `0` lands on a safe default instead of a foot-gun.
 */
const ZERO_IS_MEANINGFUL: Record<string, string> = {
  ARCHIVE_HORIZON_YEARS: 'archive any locked year that has ended',
  BACKUP_HOUR: 'midnight',
  BACKUP_GOOGLE_DRIVE_MIN_FREE_BYTES: 'skip the quota pre-flight',
}

describe('config settings whose zero is a real value', () => {
  for (const [name, meaning] of Object.entries(ZERO_IS_MEANINGFUL)) {
    it(`${name} can be set to 0 (${meaning})`, () => {
      // ⚠ The failing shape, spelled out so the diff is obvious when someone reintroduces it.
      const falsyFallback = new RegExp(`Number\\(process\\.env\\.${name}\\)\\s*\\|\\|`)
      expect(SRC).not.toMatch(falsyFallback)
      expect(SRC).toMatch(new RegExp(`numEnv\\(process\\.env\\.${name}\\s*,`))
    })
  }

  it('numEnv treats an empty value as unset, not as zero', () => {
    // `SOME_SETTING=` in a .env is a placeholder someone has not filled in. Reading it as 0
    // would turn that into a deliberate-looking instruction — the opposite of what was meant.
    expect(SRC).toMatch(/raw === undefined \|\| raw === ''/)
  })

  it('numEnv falls back rather than yielding NaN', () => {
    // `BACKUP_HOUR=midnight` must not become NaN and compare false against every hour,
    // silently disabling the schedule it was trying to set.
    expect(SRC).toMatch(/Number\.isFinite\(n\)/)
  })
})
