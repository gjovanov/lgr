#!/usr/bin/env bun
/**
 * Deleting an organisation for good, on its owner's word, once its data lives elsewhere (FR-25 §7). The engine and every
 * guard it applies: `packages/services/src/biz/org-drop/org-drop.service.ts`. The app itself never deletes an org.
 *
 *   bun scripts/drop-org.ts bundle --org <slug> --id <org id> [--subdir pre-drop] [--suffix pre-drop]
 *       a FULL backup bundle of the org, verified, written to <UPLOAD_DIR>/<org id>/backups/<subdir>/ (a subfolder: the
 *       nightly retention never counts it). Prints its path, document count and sha256; the drop needs the path and
 *       the sha256. The bundle carries the people's password hashes: it stays on the host that wrote it.
 *
 *   bun scripts/drop-org.ts drop --org <slug> --id <org id> --bundle <path> --sha256 <hex> [--execute]
 *       without --execute: every guard, and the rows per collection that would go. Writes nothing.
 *       with --execute: the guards again, the org's own document written beside the bundle (`…-org.json`, the one thing
 *       a bundle does not carry), every row under the org's id, the org, and then a count of what is left: 0 or a failure.
 *
 * The org is named twice, by slug and by id, and both must match. Counts and collection names only: no document is
 * printed. Exit 0 done, 1 refused or failed (its code first), 2 the org is homed on another node.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { assertScriptHome } from './lib/home-guard.js'
import { buildBundle, verifyBundle } from '../packages/services/src/biz/backup/backup-bundle.service.js'
import { OrgDropError, dropOrg, namedOrg } from '../packages/services/src/biz/org-drop/org-drop.service.js'

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
  const slug = required('org', '<slug>')
  const id = required('id', '<org id>')
  // Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
  await connectDB({ readOnly: true })
  await assertScriptHome(id, slug)
  await namedOrg(id, slug)

  if (command === 'bundle') {
    const subdir = value('subdir') ?? 'pre-drop'
    const suffix = value('suffix') ?? 'pre-drop'
    if (!/^[a-z0-9-]+$/.test(subdir) || !/^[a-z0-9-]+$/.test(suffix)) fail('--subdir and --suffix: lowercase letters, digits and dashes')
    const date = new Date().toISOString().slice(0, 10)
    const bundle = await buildBundle(id, { kind: 'full', date, subdir, filenameSuffix: suffix })
    const verified = await verifyBundle(bundle.absolutePath, bundle.sha256)
    if (!verified.ok) fail(`bundle_unverified: the bundle did not verify (${verified.problems.slice(0, 2).join('; ')})`)
    console.log(`bundle: ${bundle.absolutePath}`)
    console.log(`documents: ${bundle.manifest.documentCount} in ${bundle.manifest.collections.length} collections; ${bundle.bytes} bytes`)
    console.log(`sha256: ${bundle.sha256}`)
    console.log('verified: every section and the whole file')
    return 0
  }

  if (command === 'drop') {
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
    for (const [name, rows] of Object.entries(report.rows)) {
      const done = execute ? `, deleted ${report.deleted[name]}` : ''
      console.log(`  ${name}: ${rows}${report.notBundled.includes(name) ? ' (not bundled: operational or node state)' : ''}${done}`)
    }
    console.log(`rows under its id: ${report.total}${execute ? `, deleted ${Object.values(report.deleted).reduce((a, b) => a + b, 0)}` : ''}`)
    if (report.provenance) console.log(`documents outside it that keep naming it in a provenance field: ${report.provenance}`)
    if (!execute) return 0
    console.log(`org document: ${report.orgDocument!.path} (sha256 ${report.orgDocument!.sha256})`)
    console.log(`left under its id, the org included: ${report.left}`)
    return report.left === 0 ? 0 : 1
  }

  fail('usage: bun scripts/drop-org.ts bundle|drop --org <slug> --id <org id> … (see the header)')
}

main()
  .then(async code => {
    await disconnectDB()
    process.exit(code)
  })
  .catch(async e => {
    console.error(e instanceof OrgDropError ? `${e.code}: ${e.message}` : e)
    await disconnectDB().catch(() => undefined)
    process.exit(1)
  })
