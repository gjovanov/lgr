import type { RepositoryRegistry } from './registry.js'

export type DalBackend = 'mongo' | 'sqlite'

/**
 * Configuration for creating a repository registry.
 * The actual config shape depends on the backend.
 */
export interface DalConfig {
  backend: DalBackend
  /** MongoDB connection URI (for 'mongo' backend) */
  mongoUri?: string
  /** SQLite database file path (for 'sqlite' backend) */
  sqlitePath?: string
}

/**
 * Factory function type for creating a RepositoryRegistry.
 * Each backend (dal-mongo, dal-sqlite) exports a function matching this signature.
 */
export type CreateRepositories = (config: DalConfig) => Promise<RepositoryRegistry>

/**
 * Create repositories for the specified backend.
 * Dynamically imports the appropriate backend package.
 *
 * Note: Dynamic imports use string variables to prevent bundlers (bun build)
 * from trying to resolve them at compile time.
 */
export async function createRepositories(config: DalConfig): Promise<RepositoryRegistry> {
  if (config.backend === 'mongo') {
    const pkg = 'dal-mongo'
    const { createMongoRepositories } = await import(/* @vite-ignore */ pkg)
    return createMongoRepositories(config)
  }
  if (config.backend === 'sqlite') {
    const pkg = 'dal-sqlite'
    const { createSQLiteRepositories } = await import(/* @vite-ignore */ pkg)
    return createSQLiteRepositories(config)
  }
  throw new Error(`Unknown DAL backend: ${config.backend}`)
}
