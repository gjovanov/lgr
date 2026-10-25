/**
 * The server package (FR-20.25, FR-20.26, plan step P0b-9): what `scripts/build-server.ts` builds
 * and `scripts/check-package.ts` checks. One module, so the two cannot disagree on what a package
 * is, and so the tests build a bundle exactly the way the package does.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { BuildConfig } from 'bun'

export const REPO_ROOT = join(import.meta.dir, '..', '..')

/** The package's own description of itself, at its root. */
export const MANIFEST = 'server-manifest.json'

/**
 * What a package does not carry.
 *
 * - mongodb's optional peer modules. The driver requires each inside a try/catch and does
 *   without, so a package carries none of them: no native code from a dependency's optional
 *   extras.
 * - `md-to-pdf`, the previous PDF renderer, behind the cloud's `PDF_RENDERER=md-to-pdf` kill
 *   switch only (P0a-2), and loaded by a dynamic `import()`. ⚠ Bundled, its
 *   `require.resolve("highlight.js")` was SOMETIMES compiled to the build machine's absolute
 *   path (`/home/runner/work/lgr/lgr/node_modules/.bun/highlight.js@…`) and sometimes left as
 *   is. The same commit then built different bytes (CI's reproducibility check, twice on
 *   2026-10-25), and a package built the first way named a directory that exists on no master.
 *   It was the bundle's only `require.resolve`.
 */
export const BUNDLE_EXTERNALS = [
  'kerberos', 'snappy', '@mongodb-js/zstd', 'mongodb-client-encryption',
  'gcp-metadata', 'socks', 'aws4', '@aws-sdk/credential-providers',
  'md-to-pdf',
]

/**
 * Bun.build options for one server entry point, written to `outdir/<name>.js`.
 *
 * ⚠ `process.env.NODE_ENV` is defined as ITSELF, which keeps it a run-time read. Bun.build
 * otherwise replaces it with "development", even with `env: 'disable'`. Every production guard
 * then compiles to false: the bundle signs tokens with the committed development key instead of
 * refusing to start, and answers the Vite dev ports' CORS. Measured on the first bundle, whose
 * logger even took the pretty-printing transport and died on its worker.
 */
export function serverBuildOptions(entry: string, outdir: string, name: string): BuildConfig {
  return {
    entrypoints: [entry],
    target: 'bun',
    outdir,
    external: BUNDLE_EXTERNALS,
    define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
    // An imported file (the PDF letterhead) is copied next to the bundle that imports it.
    naming: { entry: `${name}.[ext]`, asset: '[name]-[hash].[ext]' },
    minify: false,
    sourcemap: 'none',
  }
}

/** The package's entry points, under `app/`. */
export const ENTRIES = [
  { name: 'server', source: 'packages/portal-api/src/unified.ts' },
  { name: 'migrate', source: 'packages/migrations/src/cli.ts' },
] as const

/**
 * The maintenance scripts a package carries, `lgr-server run-script <name>` on a master (FR-20.26).
 *
 * Vetted, and none of them writes an issued document: a tool that changes recorded sales is one a
 * seller may not be supplied with (ЗДДС чл. 118, ал. 14, т. 3). `check-package.ts` holds each to
 * that by reading its source and everything it imports. These write nomenclature only.
 *
 * Not here, on purpose:
 * - `seed-products`: its DEFAULT is `--clean`, which deletes the org's products and stock levels.
 *   It can come in once a master refuses `--clean`.
 * - `backup-crypto`: `keygen` writes the PRIVATE seal key, which never belongs on a server.
 */
export const SCRIPT_ALLOW_LIST = [
  'assign-din-tags',
  'backfill-price-tiers',
  'backfill-search-lowercase',
  'seed-din-catalog',
] as const

/** Scripts FR-20.26 names as never leaving the repository: they change issued documents. */
export const NEVER_PACKAGED = ['fix-imported-invoice-lines', 'migrate-invoice-numbering'] as const

/** The SPAs a package serves, each in `ui/<module>/` (the server reads `LGR_UI_ROOT`). */
export const UI_MODULES = ['portal', 'accounting', 'inventory', 'invoicing', 'pos', 'payroll', 'reports', 'files'] as const

/**
 * The names of the cloud's secrets: the keys of lgr-deploy's sealed `lgr-secret`, `mongodb-secret`
 * and `ocr-secret` (`k8s/base/sealed/`). Names only. A package that names one of them in a file it
 * carries (an `.env`, a manifest, a bundled config with a value) is refused. Masters boot without
 * any of the cloud's secrets (D-12). `unit/server-package.test.ts` compares this list with the
 * sealed secrets whenever lgr-deploy is checked out beside the repository.
 */
export const CLOUD_SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'BACKUP_GOOGLE_DRIVE_CLIENT_SECRET',
  'BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DESKTOP_TOKEN_SECRET',
  'DROPBOX_APP_SECRET',
  'FACEBOOK_CLIENT_SECRET',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'JWT_SECRET',
  'LINKEDIN_CLIENT_SECRET',
  'MICROSOFT_CLIENT_SECRET',
  'MONGODB_URI',
  'MONGO_INITDB_DATABASE',
  'MONGO_INITDB_ROOT_PASSWORD',
  'MONGO_INITDB_ROOT_USERNAME',
  'ONEDRIVE_CLIENT_SECRET',
  'SENDGRID_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'VERIFYVAT_TOKEN',
] as const

/** The models whose documents are issued documents, and their collections. */
export const ISSUED_DOCUMENT_MODELS = ['Invoice', 'POSTransaction', 'CashOrder'] as const
export const ISSUED_DOCUMENT_COLLECTIONS = ['invoices', 'postransactions', 'cashorders'] as const

export interface ManifestFile {
  path: string
  size: number
  sha256: string
}

export interface ServerManifest {
  name: 'lgr-server'
  format: 1
  commit: string
  /** The commit's own date, so the manifest carries no build clock and rebuilds are identical. */
  commitDate: string
  /** Built from a working tree with uncommitted changes: never a release. */
  dirty: boolean
  bun: { version: string; revision: string }
  entries: Record<string, string>
  scripts: string[]
  ui: string[]
  files: ManifestFile[]
}

/** Every file under `dir`, as POSIX paths relative to it, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(relative(dir, p).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

export function describeFile(root: string, path: string): ManifestFile {
  const bytes = readFileSync(join(root, path))
  return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
