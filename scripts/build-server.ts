#!/usr/bin/env bun
/**
 * `bun run build:server [--out <dir>]` — the server package (FR-20.26, plan step P0b-9).
 *
 * What a master runs, built from the committed lockfile and an explicit list of what goes in,
 * never `COPY . .`:
 *
 *   server-manifest.json   what it is: the commit, the Bun, its scripts and SPAs, every file's sha256
 *   app/server.js          packages/portal-api/src/unified.ts, bundled
 *   app/migrate.js         packages/migrations/src/cli.ts, bundled (`--status`, `--accept-changed`)
 *   app/scripts/<name>.js  the vetted scripts (`SCRIPT_ALLOW_LIST`), bundled
 *   app/<name>-<hash>.*    files a bundle imports (the PDF letterhead), beside it
 *   ui/web/                the built web app (FR-24.24). Run the server with `LGR_UI_ROOT=<package>/ui`.
 *
 * It copies the SPAs and does not build them: run `bun run build` first. `check-package.ts` then
 * says whether the result may ship. The same commit builds the same bytes: the manifest carries
 * the commit's date, not the build's.
 *
 * Not in it yet (plan P1): Chrome and the fonts (FR-20.25), and the supervisor that runs it.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  ENTRIES, MANIFEST, REPO_ROOT, SCRIPT_ALLOW_LIST, UI_MODULES, describeFile, listFiles, serverBuildOptions,
  type ServerManifest,
} from './lib/server-package.ts'

const args = process.argv.slice(2)
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined
const OUT = outArg ? join(process.cwd(), outArg) : join(REPO_ROOT, 'dist', 'lgr-server')

function git(...a: string[]): string {
  const r = Bun.spawnSync(['git', ...a], { cwd: REPO_ROOT })
  if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

async function bundle(source: string, outdir: string, name: string): Promise<void> {
  const result = await Bun.build(serverBuildOptions(join(REPO_ROOT, source), outdir, name))
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`bundling ${source} failed`)
  }
}

if (import.meta.main) {
  // Refuse to delete anything that is not a previous package: `--out` is a path a person typed.
  if (existsSync(OUT)) {
    const entries = readdirSync(OUT)
    if (entries.length && !entries.includes(MANIFEST)) {
      console.error(`${OUT} exists and is not a server package (no ${MANIFEST}). Choose another --out.`)
      process.exit(1)
    }
    rmSync(OUT, { recursive: true, force: true })
  }
  mkdirSync(OUT, { recursive: true })

  const missing = UI_MODULES.filter(m => !existsSync(join(REPO_ROOT, 'packages', m, 'dist', 'index.html')))
  if (missing.length) {
    console.error(`Not built: ${missing.map(m => `packages/${m}`).join(', ')}. Run \`bun run build\` first.`)
    process.exit(1)
  }

  for (const e of ENTRIES) await bundle(e.source, join(OUT, 'app'), e.name)
  for (const s of SCRIPT_ALLOW_LIST) await bundle(join('scripts', `${s}.ts`), join(OUT, 'app', 'scripts'), s)
  for (const m of UI_MODULES) cpSync(join(REPO_ROOT, 'packages', m, 'dist'), join(OUT, 'ui', m), { recursive: true })

  const dirty = git('status', '--porcelain').length > 0
  const manifest: ServerManifest = {
    name: 'lgr-server',
    format: 1,
    commit: git('rev-parse', 'HEAD'),
    commitDate: git('log', '-1', '--format=%cI'),
    dirty,
    bun: { version: Bun.version, revision: Bun.revision },
    entries: Object.fromEntries(ENTRIES.map(e => [e.name, `app/${e.name}.js`])),
    scripts: [...SCRIPT_ALLOW_LIST],
    ui: [...UI_MODULES],
    files: listFiles(OUT).map(p => describeFile(OUT, p)),
  }
  writeFileSync(join(OUT, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')

  const bytes = manifest.files.reduce((n, f) => n + f.size, 0)
  console.log(`Built ${relative(process.cwd(), OUT) || OUT}: ${manifest.files.length} files, ${(bytes / 1e6).toFixed(1)} MB, commit ${manifest.commit.slice(0, 12)}${dirty ? ' (DIRTY working tree: not a release)' : ''}`)
  for (const [name, path] of Object.entries(manifest.entries)) console.log(`  ${name.padEnd(8)} ${path} ${(statSync(join(OUT, path)).size / 1e6).toFixed(1)} MB`)
}
