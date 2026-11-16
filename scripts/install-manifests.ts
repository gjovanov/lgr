/**
 * What the image's dependency layer is keyed on: each package.json as `bun install` reads it.
 *
 * The Dockerfile's `deps` stage copies the manifests and the lockfile and runs `bun install`, and
 * BuildKit reuses that layer (1.15 GB: node_modules and puppeteer's Chrome) for as long as what
 * it copies has the same bytes. Copied whole, a package.json changes for reasons the install
 * never sees. Here the common one is `exports`: `config` and the UI packages list their modules
 * there, so a new module is a new line. Of the 24 merges from 2026-10-28 to 2026-11-11 that
 * changed a manifest or the lockfile, 15 changed `exports` and nothing else, and each made its
 * deploy install, push and pull the whole layer again (256 s on 2026-11-11 for two such lines,
 * where the deploys around it took 25 to 44 s).
 *
 * So the copies the install is given have that key taken out. Only those copies: the image's own
 * package.json files come from the repository, whole, in its last layer.
 *
 * Usage: bun scripts/install-manifests.ts <dir>
 *        rewrites <dir>/package.json and every <dir>/packages/<name>/package.json in place
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Keys that say how a package's files are found by whoever imports it. `bun install` links a
 * workspace package as a directory and never opens them.
 *
 * ⚠ A key belongs here only if the install provably does not read it. One that it does read
 * (`dependencies` and its siblings, `workspaces`, `scripts` with its lifecycle hooks, `bin`,
 * `overrides`, `trustedDependencies`, `patchedDependencies`, the name and the version) would
 * leave the layer as it was on a change that matters: an old node_modules under new code, and
 * no build step to say so. unit/install-manifests.test.ts holds this list to what it may name.
 */
export const NOT_READ_BY_INSTALL = ['exports'] as const

/** One manifest as the install is given it: the same keys in the same order, in one fixed layout. */
export function installManifest(text: string): string {
  const manifest = JSON.parse(text)
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('a package.json holds one object')
  }
  for (const key of NOT_READ_BY_INSTALL) delete manifest[key]
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** The manifests of a tree laid out like this repository: the root's, and one per `packages/<name>`. */
export function manifestsUnder(dir: string): string[] {
  const out = [join(dir, 'package.json')]
  const packages = join(dir, 'packages')
  if (existsSync(packages)) {
    for (const name of readdirSync(packages).sort()) {
      const file = join(packages, name, 'package.json')
      if (existsSync(file)) out.push(file)
    }
  }
  return out
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: bun scripts/install-manifests.ts <dir>')
    process.exit(2)
  }
  const files = manifestsUnder(dir)
  for (const file of files) writeFileSync(file, installManifest(readFileSync(file, 'utf8')))
  console.log(`install manifests: ${files.length} written without ${NOT_READ_BY_INSTALL.join(', ')}`)
}
