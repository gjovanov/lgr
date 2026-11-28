import type { mongo } from 'mongoose'
import { runMigrations, type ContractMode, type RunResult } from './runner.js'
import type { Migration } from './types.js'

type Db = mongo.Db

/**
 * #980 (FR-20.20): the API's own run of the migrations at its start (`MIGRATIONS_AUTO=true`), as a
 * master's supervisor says to run it.
 *
 * A master's update is a start of the new version that its update helper watches: confirmed after five
 * clean minutes, or gone back from, to the version before, which then meets the data as the new one
 * left it. The supervisor reads the helper's state (`install.rs#UpdateState`) and tells the API, in its
 * environment (`config.rs#update_env`, `migration_hold.rs`):
 *   - `LGR_MIGRATIONS_CONTRACT=hold`: this start is the switch being watched, or the state could not be
 *     read. The CONTRACT steps (`registry.ts`) are held and the rest run. Once the update is confirmed,
 *     the supervisor asks for them on the control socket (`POST /migrations/release`, `releaseHeld`),
 *     once for each start of the API: a respawned API is given the same environment, and holds again;
 *   - `LGR_MIGRATIONS_CONTRACT=try`: any other start of an installed master. A contract step that fails
 *     waits for a later start: there is no version to go back to any more, and nobody to start it again;
 *   - `LGR_MIGRATIONS_FAILED_VERSIONS`: the versions that failed their confirmation. What they applied
 *     is applied again, because the version gone back to has written in the old shape since;
 *   - `LGR_SERVER_VERSION`: what every step applied here is recorded under.
 * Anywhere else (lgrai.app, a development server) none is named, and it is the runner as it was.
 *
 * ⚠ The API never reads the helper's state itself. Bun opens every file without FILE_SHARE_DELETE on
 * Windows (`readFileSync`, `Bun.file().text()`, `fs.promises.readFile`, `openSync` alike, measured on
 * Bun 1.3), so a read that overlaps the helper's save fails its rename over the file ("Access is
 * denied"), and the helper could not record a confirmation or a go-back. The supervisor reads it with
 * Rust's std, which shares delete.
 */

/** What the supervisor says of this start. An unknown value holds: a held contract step costs nothing. */
export function startModeFromEnv(env: Record<string, string | undefined>): {
  contract: ContractMode
  failedVersions: string[]
  version?: string
  /** A value of `LGR_MIGRATIONS_CONTRACT` this API does not know. */
  unknown?: string
} {
  const said = env.LGR_MIGRATIONS_CONTRACT?.trim()
  const contract: ContractMode = !said ? 'apply' : said === 'hold' || said === 'try' ? said : 'hold'
  const failedVersions = (env.LGR_MIGRATIONS_FAILED_VERSIONS ?? '').split(',').map(v => v.trim()).filter(Boolean)
  return {
    contract,
    failedVersions,
    version: env.LGR_SERVER_VERSION?.trim() || undefined,
    ...(said && contract === 'hold' && said !== 'hold' ? { unknown: said } : {}),
  }
}

/** What the API's status says of its migrations (`/status`, which the supervisor's status carries). */
export interface StartMigrationsHealth {
  /** What the supervisor said of this start: `apply` when it said nothing. */
  contract: ContractMode
  /** The contract steps not applied. */
  held: string[]
  /** Why: the update is not confirmed yet (the supervisor releases them), or one of them failed. */
  heldBecause: 'confirmation' | 'failed' | null
  /** The contract steps that failed, each with its error. They wait for a later start. */
  deferred: Array<{ id: string; error: string }>
  /** When the steps held for the confirmation ran, once the supervisor released them. */
  releasedAt: string | null
  /** The steps applied again because a version that failed its confirmation had applied them. */
  reapplied: string[]
  /** The versions that failed their confirmation, as the supervisor named them. */
  failedVersions: string[]
}

let health: StartMigrationsHealth | null = null
/** How the steps held for the confirmation run, while they wait for the supervisor's release. */
let waiting: { run: () => Promise<RunResult>; o: StartOptions } | null = null
let releasing: Promise<void> | null = null

/** This process's start migrations, or `null` when it ran none (`MIGRATIONS_AUTO` off). */
export function startMigrationsHealth(): StartMigrationsHealth | null {
  return health
}

export interface StartOptions {
  db: Db
  /** The org scope, read at each run: a master's homes (`homeScope`). */
  scope: () => Promise<Record<string, unknown>>
  log: (message: string, extra?: Record<string, unknown>) => void
  /** Where what needs a person's eye is said: a step that failed, a value nobody knows. */
  warn: (message: string, extra?: Record<string, unknown>) => void
  /** The supervisor's word: `process.env` (see the header). */
  env: Record<string, string | undefined>
  migrations?: Migration[]
}

function sayDeferred(o: StartOptions, result: RunResult): void {
  for (const d of result.deferred) {
    o.warn(`Migrations: ${d.id} failed, and waits for a later start with the contract steps after it`, { migration: d.id, error: d.error })
  }
}

/** The run at the start: see the header. Throws what a failing step that is not a contract step throws. */
export async function migrateAtStart(o: StartOptions): Promise<RunResult> {
  waiting = null
  const mode = startModeFromEnv(o.env)
  if (mode.unknown) o.warn(`Migrations: the supervisor said ${JSON.stringify(mode.unknown)} of the contract steps, which this version does not know: they are held`)
  const run = async (contract: ContractMode) => runMigrations({
    db: o.db,
    migrations: o.migrations,
    appVersion: mode.version,
    orgFilter: await o.scope(),
    log: o.log,
    contract,
    failedVersions: mode.failedVersions,
  })
  const result = await run(mode.contract)
  sayDeferred(o, result)
  const held = mode.contract === 'hold' && result.held.length > 0
  health = {
    contract: mode.contract,
    held: result.held,
    heldBecause: held ? 'confirmation' : result.held.length ? 'failed' : null,
    deferred: result.deferred,
    releasedAt: null,
    reapplied: result.reapplied,
    failedVersions: mode.failedVersions,
  }
  if (held) waiting = { run: () => run('try'), o }
  o.log(result.held.length
    ? `Migrations up to date, but for ${result.held.length} contract step(s) that wait (${health.heldBecause})`
    : 'Migrations up to date', { applied: result.applied, alreadyApplied: result.alreadyApplied.length, held: result.held, reapplied: result.reapplied })
  return result
}

/** The answer to the supervisor's release (`POST /migrations/release`). */
export interface ReleaseAnswer {
  /** Nothing waits for the confirmation any more: the supervisor stops asking, for this start. */
  released: boolean
  /** A run of what was held is under way. */
  releasing: boolean
  held: string[]
}

/**
 * The supervisor's release, once it has seen the update confirmed: runs what this start held for the
 * confirmation, in the background, and answers at once. It asks again until the answer says `released`,
 * so a run that fails (the database went away) is tried again, and a run under way is never started
 * twice. A contract step that fails in it waits for a later start, as at any start that is not watched.
 */
export function releaseHeld(): ReleaseAnswer {
  const held = health?.held ?? []
  if (releasing) return { released: false, releasing: true, held }
  if (!waiting) return { released: true, releasing: false, held }
  const w = waiting
  releasing = (async () => {
    try {
      const result = await w.run()
      sayDeferred(w.o, result)
      health = {
        ...health!,
        held: result.held,
        heldBecause: result.held.length ? 'failed' : null,
        deferred: result.deferred,
        releasedAt: new Date().toISOString(),
        reapplied: [...(health?.reapplied ?? []), ...result.reapplied],
      }
      waiting = null
      w.o.log('Migrations: the update is confirmed, and the contract steps held while it was watched ran', { applied: result.applied, held: result.held })
    } catch (e: any) {
      w.o.warn(`Migrations: the contract steps held while the update was watched could not run yet, and are tried again: ${e?.message ?? e}`)
    } finally {
      releasing = null
    }
  })()
  return { released: false, releasing: true, held }
}

/** The release under way, if any: what a test awaits. */
export function releaseSettled(): Promise<void> {
  return releasing ?? Promise.resolve()
}

/** Forgets this process's start migrations: for a test that runs more than one start. */
export function forgetStartMigrations(): void {
  health = null
  waiting = null
}
