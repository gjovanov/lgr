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
 */
export async function createRepositories(config: DalConfig): Promise<RepositoryRegistry> {
  if (config.backend === 'mongo') {
    const { createMongoRepositories } = await import('dal-mongo')
    return createMongoRepositories(config)
  }
  if (config.backend === 'sqlite') {
    const { createSQLiteRepositories } = await import('dal-sqlite')
    return createSQLiteRepositories(config)
  }
  throw new Error(`Unknown DAL backend: ${config.backend}`)
}
