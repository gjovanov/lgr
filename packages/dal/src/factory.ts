import type { RepositoryRegistry } from './registry.js'

/**
 * ⚠ One member, on purpose. `'sqlite'` was the desktop's local mode, and that is gone
 * (FR-14.34) — `dal-sqlite` no longer exists, so a config naming it could only ever fail at the
 * dynamic import. The union is kept rather than collapsed away because the interface, and the
 * indirection below, are the point of this package: a second backend would be added here.
 */
export type DalBackend = 'mongo'

/**
 * Configuration for creating a repository registry.
 * The actual config shape depends on the backend.
 */
export interface DalConfig {
  backend: DalBackend
  /** MongoDB connection URI (for 'mongo' backend) */
  mongoUri?: string
}

/**
 * Factory function type for creating a RepositoryRegistry.
 * The backend package (`dal-mongo`) exports a function matching this signature.
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
  throw new Error(`Unknown DAL backend: ${config.backend}`)
}
