#!/usr/bin/env bun
/**
 * Deleting an organisation for good, on its owner's word, once its data lives elsewhere (FR-25 §7). The engine and every
 * guard it applies: `packages/services/src/biz/org-drop/org-drop.service.ts`. The app itself never deletes an org.
 *
 *   bun scripts/drop-org.ts bundle --org <slug> --id <org id> [--subdir pre-drop] [--suffix pre-drop]
 *       a FULL backup bundle of the org, verified, written to <UPLOAD_DIR>/<org id>/backups/<subdir>/ (a subfolder: the
 *       nightly retention never counts it), mode 600. It refuses to write over a bundle of the same day and suffix.
 *       Prints its path, document count and sha256; the drop needs the path and the sha256. The bundle carries the
 *       people's password hashes: it stays on the host that wrote it.
 *
 *   bun scripts/drop-org.ts drop --org <slug> --id <org id> --bundle <path> --sha256 <hex> [--execute]
 *       without --execute: every guard, and the rows per collection that would go. Writes nothing.
 *       with --execute: the guards again; the org's file beside the bundle (`…-org.json`, mode 600: the org's own
 *       document, which a bundle does not carry, and its operational records, without its cloud-storage tokens); every
 *       row the bundle was proven to hold, by id; and the org, once nothing is left under its id. A run that stopped
 *       part way can be run again with the same bundle.
 *
 * The org is named twice, by slug and by id, and both must match. Counts and collection names only: no document is
 * printed. Exit 0 done, 1 refused or failed (its code first), 2 the org is homed on another node.
 */
import { chmod, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { assertScriptHome } from './lib/home-guard.js'
import { bundleDir, buildBundle, verifyBundle } from '../packages/services/src/biz/backup/backup-bundle.service.js'
import { OrgDropError, asOrgId, dropOrg, namedOrg } from '../packages/services/src/biz/org-drop/org-drop.service.js'

const argv = process.argv.slice(2)
const command = argv[0]
const flag = (name: string) => argv.includes(`--${name}`)
function value(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : undefined
}
function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}
const required = (name: string, hint: string) => value(name) ?? fail(`--${name} ${hint}`)

async function main(): Promise<number> {
  if (command !== 'bundle' && command !== 'drop') fail('usage: bun scripts/drop-org.ts bundle|drop --org <slug> --id <org id> … (see the header)')
  const slug = required('org', '<slug>')
  const id = required('id', '<org id>')
  asOrgId(id)
  // Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
  await connectDB({ readOnly: true })
  await assertScriptHome(id, slug)
  await namedOrg(id, slug)

  if (command === 'bundle') {
    const subdir = value('subdir') ?? 'pre-drop'
    const suffix = value('suffix') ?? 'pre-drop'
    if (!/^[a-z0-9-]+$/.test(subdir) || !/^[a-z0-9-]+$/.test(suffix)) fail('--subdir and --suffix: lowercase letters, digits and dashes')
    const date = new Date().toISOString().slice(0, 10)
    // A bundle is written over a file of the same name, and one of today may be the copy a drop already relied on.
    const dir = join(bundleDir(id), subdir)
    const taken = (await readdir(dir).catch(() => [] as string[])).find(f => f.endsWith(`-full-${date}-${suffix}.ndjson.zst`))
    if (taken) fail(`bundle_exists: ${join(dir, taken)} is already there. Use it, or pick another --suffix`)
    const bundle = await buildBundle(id, { kind: 'full', date, subdir, filenameSuffix: suffix })
    await chmod(bundle.absolutePath, 0o600)
    const verified = await verifyBundle(bundle.absolutePath, bundle.sha256)
    if (!verified.ok) fail(`bundle_unverified: the bundle did not verify (${verified.problems.slice(0, 2).join('; ')})`)
    console.log(`bundle: ${bundle.absolutePath}`)
    console.log(`documents: ${bundle.manifest.documentCount} in ${bundle.manifest.collections.length} collections; ${bundle.bytes} bytes`)
    console.log(`sha256: ${bundle.sha256}`)
    console.log('verified: every section and the whole file')
    return 0
  }

  const execute = flag('execute')
  const report = await dropOrg({
    orgId: id,
    expectSlug: slug,
    bundlePath: required('bundle', '<path of a verified full bundle of this org>'),
    bundleSha256: required('sha256', '<the sha256 the bundle was written with>'),
    execute,
    log: line => console.error(line),
  })
  console.log(`${report.org.slug} (${report.org.id})${execute ? '' : '   DRY RUN: nothing was written or deleted'}`)
  console.log(`bundle: ${report.bundle.path}, ${report.bundle.documentCount} documents, written ${report.bundle.createdAt}, verified`)
  console.log('every row below is in the bundle with the same content, or saved in the org\'s file (operational)')
  for (const [name, rows] of Object.entries(report.rows)) {
    const done = execute ? `, deleted ${report.deleted[name]}` : ''
    console.log(`  ${name}: ${rows}${report.operational.includes(name) ? ' (operational: saved in the org\'s file)' : ''}${done}`)
  }
  console.log(`rows under its id: ${report.total}${execute ? `, deleted ${Object.values(report.deleted).reduce((a, b) => a + b, 0)}` : ''}`)
  if (report.provenance) console.log(`documents outside it that keep naming it in a provenance field: ${report.provenance}`)
  if (!execute) return 0
  console.log(`org file: ${report.saved!.path} (sha256 ${report.saved!.sha256}${report.saved!.reused ? ', written by an earlier run' : ''})`)
  console.log(`left under its id: ${report.orgDeleted ? 0 : report.left}; the org ${report.orgDeleted ? 'deleted' : 'KEPT: rows are left under its id'}`)
  return report.orgDeleted ? 0 : 1
}

main()
  .then(async code => {
    await disconnectDB()
    process.exit(code)
  })
  .catch(async e => {
    console.error(e instanceof OrgDropError ? `${e.code}: ${e.message}` : `unexpected: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    await disconnectDB().catch(() => undefined)
    process.exit(e instanceof OrgDropError && e.code === 'home_elsewhere' ? 2 : 1)
  })
