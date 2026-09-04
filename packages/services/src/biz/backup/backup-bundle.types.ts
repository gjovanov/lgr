/**
 * FR-13.12 (#24) — the bundle's wire shapes.
 *
 * Import-pure: no models, no mongoose, no fs. The controller and the tests import this; the
 * builder is the server-only half. Same split as `daily-digest.types.ts`.
 */

/** Bump only for a breaking change to the container layout — a restore compares on it. */
export const BUNDLE_FORMAT = 'lgr-backup-1'

export interface BackupCollectionSection {
  /** Mongoose model name, e.g. `Invoice` — stable across collection renames. */
  name: string
  /** The underlying MongoDB collection, for anyone reading the bundle without this codebase. */
  collection: string
  count: number
  bytes: number
  /** SHA-256 over this collection's NDJSON section as written. */
  sha256: string
}

export interface BackupBundleManifest {
  format: string
  orgId: string
  orgSlug: string
  orgName: string
  kind: 'full' | 'delta'
  /** Org-local `YYYY-MM-DD` the run was claimed under. */
  date: string
  createdAt: string
  coversFrom?: string
  coversTo?: string
  schemaVersion: string
  /** Refuse a bundle newer than the running code on restore (FR-13.31). */
  appImageTag: string
  documentCount: number
  collections: BackupCollectionSection[]
}

export interface BackupVerifyResult {
  ok: boolean
  /** False only when the compressed artifact itself failed its checksum. */
  bundleShaOk: boolean
  collections: { name: string; expected: number; found: number; shaOk: boolean }[]
  documentCount: number
  problems: string[]
  manifest?: BackupBundleManifest
}
