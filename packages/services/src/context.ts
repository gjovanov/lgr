import type { RepositoryRegistry } from 'dal'

let _repos: RepositoryRegistry | null = null

/**
 * Initialize the service layer with a RepositoryRegistry.
 * Must be called once at app startup (before any service/DAO usage).
 *
 * - Cloud API: pass MongoDB-backed registry from `dal-mongo`
 *
 * ⚠ There is one backend. A SQLite-backed registry for the desktop's local mode used to be the
 * other, and local mode is gone (FR-14.34).
 */
export function initServiceContext(repos: RepositoryRegistry): void {
  _repos = repos
}

/**
 * Get the current RepositoryRegistry.
 * Throws if `initServiceContext()` has not been called.
 */
export function getRepos(): RepositoryRegistry {
  if (!_repos) {
    throw new Error('Service context not initialized. Call initServiceContext(repos) at startup.')
  }
  return _repos
}

/**
 * Check if the service context has been initialized.
 */
export function isContextInitialized(): boolean {
  return _repos !== null
}
