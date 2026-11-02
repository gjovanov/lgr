import type { Db } from 'mongodb'

/**
 * A data migration (FR-20.19): a change a release needs in the data, shipped in the codebase and
 * run by every node, instead of a `scripts/migrate-*.ts` someone runs by hand. A master has no
 * operator to run one.
 *
 * ⚠ Rules every migration follows:
 * - **Idempotent.** Running it twice changes nothing the second time. AC 8 runs every registered
 *   migration twice on a seeded database and compares.
 * - **Expand, then contract, across one release.** It only adds what the new code reads, and the
 *   previous release keeps working on the result (FR-20.20: a binary rollback must not meet data it
 *   cannot read). Removing the old shape is a later migration.
 * - **Never edited once released.** The runner records a checksum of the migration's file and
 *   refuses to start if an applied migration's code changed. A fix is a new migration.
 * - **Scoped by `ctx.orgFilter`** when it touches org data, so a node migrates only its own orgs.
 */
export interface Migration {
  /** `NNNN-kebab-name`. The registry runs them in this order; ids are never reused. */
  id: string
  /** One line: what it changes and why. */
  description: string
  up(ctx: MigrationContext): Promise<void>
  /**
   * What `up` would do, a line per change, writing nothing: `bun run migrate --dry-run`. Optional: a
   * migration that decides per org has an answer worth reading before it runs, and a schema change
   * does not.
   */
  preview?(ctx: MigrationContext): Promise<string[]>
  /**
   * The SHA-256 of the migration's file (`fingerprints.json`, attached by the registry). The
   * runner's checksum is taken over it, never over `up`, which a bundle prints differently. A
   * migration without one (a test's) is checksummed over `up` as before.
   */
  fingerprint?: string
}

export interface MigrationContext {
  /** The native driver's database: migrations run before models matter, and bypass their hooks. */
  db: Db
  log: (message: string, extra?: Record<string, unknown>) => void
  /**
   * Merge into every org-data filter. `{}` today, which is every org. FR-20.5 (plan step P0b-3)
   * narrows it to the orgs whose home is this node, so a master never rewrites mirrored data.
   */
  orgFilter: Record<string, unknown>
}

/** A row of `_migrations`. `_id` is the migration id. */
export interface MigrationRecord {
  _id: string
  description: string
  appliedAt: Date
  durationMs: number
  appVersion: string
  checksum: string
}
