import type { Migration } from '../types.js'

/**
 * The starting point: the data as it stands when versioned migrations began (FR-20.19). It
 * changes nothing. Recording it marks a database as managed by the runner, so `--status` can tell
 * a database that never ran a migration from one that is up to date.
 *
 * The hand-run scripts before it (`scripts/migrate-*.ts`) are history; nothing replays them.
 */
export const baseline: Migration = {
  id: '0000-baseline',
  description: 'Baseline: the data as it stood when versioned migrations began',
  async up() {
    // Intentionally empty.
  },
}
