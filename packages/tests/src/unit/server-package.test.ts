import { describe, it, expect, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CLOUD_SECRET_NAMES, MANIFEST, NEVER_PACKAGED, REPO_ROOT, SCRIPT_ALLOW_LIST, describeFile, listFiles,
  type ServerManifest,
} from '../../../../scripts/lib/server-package.ts'
import { checkPackage, foreignOriginHits, issuedDocumentHits, secretNameHits } from '../../../../scripts/check-package.ts'
import { GLOBAL_ANALYTICS_TAG, MASTER_NODE_TAG, portalShellFor } from '../../../portal-api/src/spa-fallback.js'
import { MASTER_NODE_TAG as UI_MASTER_NODE_TAG, servedByMaster } from '../../../ui-shared/src/nav/node-role.js'

/**
 * The server package may hold only what it lists, and nothing a master must not carry (FR-20.26,
 * plan step P0b-9). AC 21: the check fails on a planted secret or ignored path. AC 66: on a
 * third-party origin in a built SPA. AC 67: on a packaged script that can write an issued document.
 *
 * Every refusal is planted into a package that is otherwise clean, and the clean one passes, so a
 * check that refused everything would fail here too.
 */

const scratch = mkdtempSync(join(tmpdir(), 'lgr-pkg-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0

const CLEAN: Record<string, string> = {
  'app/server.js': 'const env = process.env.NODE_ENV\nconst config = { secret: process.env.JWT_SECRET, JWT_SECRET: process.env.JWT_SECRET }\n',
  'app/migrate.js': 'if (process.env.NODE_ENV === "production") {}\n',
  'app/scripts/assign-din-tags.js': 'console.log("dry run")\n',
  'ui/portal/index.html': '<!doctype html><html><head><script type="module" src="/assets/index-a1.js"></script><link rel="stylesheet" href="/assets/index-a1.css"></head><body><div id="app"></div></body></html>\n',
  'ui/portal/assets/index-a1.js': 'const docs = "https://vuejs.org/guide/"; const ns = "http://www.w3.org/2000/svg"; fetch("/api/health")\n',
  'ui/portal/assets/index-a1.css': 'body { background: url(/assets/bg.png) }\n',
}

/** A package directory holding `files`, with a manifest that lists exactly them unless told otherwise. */
function makePackage(files: Record<string, string>, opts: { scripts?: string[]; after?: Record<string, string> } = {}): string {
  const dir = join(scratch, `p${n++}`)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  const manifest: ServerManifest = {
    name: 'lgr-server', format: 1, commit: '0'.repeat(40), commitDate: '2026-10-24T00:00:00Z', dirty: false,
    bun: { version: Bun.version, revision: Bun.revision },
    entries: { server: 'app/server.js', migrate: 'app/migrate.js' },
    scripts: opts.scripts ?? ['assign-din-tags'],
    ui: ['portal'],
    files: listFiles(dir).map(p => describeFile(dir, p)),
  }
  writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest))
  for (const [path, text] of Object.entries(opts.after ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const rulesOf = (dir: string) => checkPackage(dir).map(f => `${f.rule} ${f.path}`)

/** A planted value. Built at run time, so the source holds no literal a secret scanner flags. */
const PLANTED = ['planted', 'value'].join('-')

describe('check-package refuses what a master must not carry', () => {
  it('passes a clean package: the control for every refusal below', () => {
    expect(checkPackage(makePackage(CLEAN))).toEqual([])
  })

  const planted: Array<[string, Record<string, string>, string]> = [
    ['an ignored upload', { 'uploads/org1/invoice.pdf': '%PDF-' }, 'gitignored uploads/org1/invoice.pdf'],
    ['an ignored log', { 'app/server.log': 'x' }, 'gitignored app/server.log'],
    ['an ignored export', { 'ui/portal/products.xlsx': 'x' }, 'gitignored ui/portal/products.xlsx'],
    ['.secrets/', { '.secrets/google-oauth-client.json': '{}' }, 'secret-file .secrets/google-oauth-client.json'],
    ['a seal key', { 'app/backup.seal.key': 'x' }, 'secret-file app/backup.seal.key'],
    ['the seal key by its name', { 'lgr-seal.key': 'x' }, 'secret-file lgr-seal.key'],
    ['an env file', { 'app/.env.production': 'NODE_ENV=production' }, 'secret-file app/.env.production'],
    ['an env example too', { '.env.example': 'X=1' }, 'secret-file .env.example'],
    ['a secret named in a data file', { 'app/defaults.json': '{"SENDGRID_API_KEY":"SG.x"}' }, 'secret-name app/defaults.json'],
    ['a secret given a value in a bundle', { 'app/server.js': CLEAN['app/server.js'] + `const e = { JWT_SECRET: "${PLANTED}" }\n` }, 'secret-name app/server.js'],
    ['an env line inlined into a bundle', { 'app/migrate.js': CLEAN['app/migrate.js'] + 'MONGODB_URI=mongodb://db:27017/lgr\n' }, 'secret-name app/migrate.js'],
    ['an analytics script in a shell', { 'ui/portal/index.html': GLOBAL_ANALYTICS_TAG }, 'foreign-origin ui/portal/index.html'],
    ['a hosted font', { 'ui/portal/assets/index-a1.css': '@import url(https://fonts.googleapis.com/css?family=Roboto);' }, 'foreign-origin ui/portal/assets/index-a1.css'],
    ['a script loaded at run time', { 'ui/portal/assets/index-a1.js': 'import("https://cdn.example.com/widget.js")' }, 'foreign-origin ui/portal/assets/index-a1.js'],
    ['a beacon', { 'ui/portal/assets/index-a1.js': 'navigator.sendBeacon("https://stats.example.com/e", d)' }, 'foreign-origin ui/portal/assets/index-a1.js'],
    ['a known tracker named anywhere', { 'ui/portal/assets/index-a1.js': 'const t = "www.googletagmanager.com/gtm.js"' }, 'foreign-origin ui/portal/assets/index-a1.js'],
    ['a bundle with NODE_ENV inlined', { 'app/server.js': 'if ("development" === "production") {}\n' }, 'node-env app/server.js'],
    ['a script the manifest does not name', { 'app/scripts/rogue.js': 'x' }, 'script app/scripts/rogue.js'],
  ]

  for (const [what, extra, expected] of planted) {
    it(`refuses ${what}`, () => {
      expect(rulesOf(makePackage({ ...CLEAN, ...extra }))).toContain(expected)
    })
  }

  it('refuses a file added after the manifest, one whose bytes changed, and one gone missing', () => {
    const added = makePackage(CLEAN, { after: { 'app/extra.js': 'x' } })
    expect(rulesOf(added)).toContain('manifest app/extra.js')
    const changed = makePackage(CLEAN, { after: { 'app/scripts/assign-din-tags.js': 'console.log("tampered")\n' } })
    expect(rulesOf(changed)).toContain('manifest app/scripts/assign-din-tags.js')
    const gone = makePackage(CLEAN)
    rmSync(join(gone, 'ui/portal/assets/index-a1.css'))
    expect(rulesOf(gone)).toContain('manifest ui/portal/assets/index-a1.css')
  })

  it('refuses a script that never leaves the repository, and one with no source to vet', () => {
    const rules = rulesOf(makePackage(CLEAN, { scripts: ['assign-din-tags', 'fix-imported-invoice-lines', 'no-such-script'] }))
    expect(rules).toContain('script app/scripts/fix-imported-invoice-lines.js')
    expect(rules).toContain('script app/scripts/no-such-script.js')
  })

  it('refuses a directory with no manifest at all', () => {
    const dir = join(scratch, 'not-a-package')
    mkdirSync(dir, { recursive: true })
    expect(rulesOf(dir)).toEqual([`manifest ${MANIFEST}`])
  })
})

describe('the string rules, with the cases they must leave alone', () => {
  it('in a server bundle, a secret read from the environment is not a finding; a value is', () => {
    expect(secretNameHits('app/server.js', 'secret: process.env.JWT_SECRET, x: requiredSecret("JWT_SECRET", process.env.JWT_SECRET)')).toEqual([])
    expect(secretNameHits('app/server.js', 'JWT_SECRET=process.env.JWT_SECRET')).toEqual([])
    expect(secretNameHits('app/server.js', `"STRIPE_SECRET_KEY": "${PLANTED}"`)).toEqual(['STRIPE_SECRET_KEY is given a value'])
  })

  it('outside the bundles, a secret is not even to be named', () => {
    expect(secretNameHits('ui/portal/assets/a.js', 'const k = "VERIFYVAT_TOKEN"')).toEqual(['names VERIFYVAT_TOKEN'])
    expect(secretNameHits('ui/portal/assets/a.js', 'const MY_JWT_SECRETS = 1')).toEqual([])
  })

  it('a library\'s documentation link or an SVG namespace is not an origin the SPA loads', () => {
    const text = 'warn("see https://v3-migration.vuejs.org/breaking-changes"); el.setAttribute("xmlns", "http://www.w3.org/2000/svg")'
    expect(foreignOriginHits('ui/x/assets/a.js', text)).toEqual([])
    expect(foreignOriginHits('ui/x/assets/a.js', 'img.src = "https://tracker.example/p.gif"')).toEqual(['loads https://tracker.example/p.gif'])
  })
})

describe('no packaged script can write an issued document (AC 67)', () => {
  it('every allow-listed script exists and passes, and none is one that must stay in the repository', () => {
    for (const name of SCRIPT_ALLOW_LIST) {
      const source = join(REPO_ROOT, 'scripts', `${name}.ts`)
      expect({ name, exists: existsSync(source) }).toEqual({ name, exists: true })
      expect({ name, hits: issuedDocumentHits(source) }).toEqual({ name, hits: [] })
    }
    for (const name of NEVER_PACKAGED) expect(SCRIPT_ALLOW_LIST as readonly string[]).not.toContain(name)
  })

  it('catches the real invoice-changing scripts (the positive control on real sources)', () => {
    for (const name of NEVER_PACKAGED) {
      const hits = issuedDocumentHits(join(REPO_ROOT, 'scripts', `${name}.ts`))
      expect({ name, caught: hits.length > 0 }).toEqual({ name, caught: true })
    }
  })

  const synthetic = join(scratch, 'scripts')
  mkdirSync(join(synthetic, 'lib'), { recursive: true })
  const write = (name: string, text: string) => { writeFileSync(join(synthetic, name), text); return join(synthetic, name) }

  it('follows imports: a write two modules away is still the script\'s', () => {
    write('lib/void.ts', "import { Invoice } from 'db/models'\nexport const voidAll = () => Invoice.updateMany({}, { $set: { status: 'voided' } })\n")
    write('lib/helper.ts', "export { voidAll } from './void.ts'\n")
    const hits = issuedDocumentHits(write('a.ts', "import { voidAll } from './lib/helper.ts'\nawait voidAll()\n"), REPO_ROOT)
    expect(hits.some(h => h.includes('imports Invoice'))).toBe(true)
  })

  it('catches a raw collection, a model looked up by name, and an unknowable namespace import', () => {
    expect(issuedDocumentHits(write('b.ts', "await db.collection('postransactions').deleteMany({})\n"), REPO_ROOT)).toEqual([expect.stringContaining('postransactions collection')])
    expect(issuedDocumentHits(write('c.ts', "await mongoose.model('CashOrder').updateOne({}, {})\n"), REPO_ROOT)).toEqual([expect.stringContaining('CashOrder model')])
    expect(issuedDocumentHits(write('d.ts', "import * as M from '../packages/db/src/models/index.js'\n"), REPO_ROOT)).toEqual([expect.stringContaining('cannot be checked')])
  })

  it('leaves a script that writes nomenclature alone', () => {
    expect(issuedDocumentHits(write('e.ts', "import { Product, Tag } from 'db/models'\nawait Product.updateMany({}, { $set: { x: 1 } })\n"), REPO_ROOT)).toEqual([])
  })
})

describe('the analytics tag is lgrai.app\'s alone (AC 66)', () => {
  const shell = '<!doctype html><html><head><title>LGR</title></head><body></body></html>'

  it('global serves the portal shell with it, once; a master without it', () => {
    const global = portalShellFor(shell, 'global')
    expect(global.split(GLOBAL_ANALYTICS_TAG).length).toBe(2)
    expect(portalShellFor(global, 'global')).toBe(global)
    expect(portalShellFor(shell, 'master')).not.toContain(GLOBAL_ANALYTICS_TAG)
  })

  it('the SPA\'s index.html carries no origin of its own, so no build does', () => {
    // FR-24.21: one SPA (`packages/web`), the shell every page is served.
    for (const ui of ['web']) {
      const html = readFileSync(join(REPO_ROOT, 'packages', ui, 'index.html'), 'utf8')
      expect({ ui, hits: foreignOriginHits('index.html', html) }).toEqual({ ui, hits: [] })
    }
  })
})

// gjovanov/lgr#384: a till's first screen of its master was lgrai.app's marketing landing page.
describe('a master\'s portal shell says it is one, and the portal reads it', () => {
  const shell = '<!doctype html><html><head><title>LGR</title></head><body></body></html>'
  // The one `querySelector` the portal asks of its document, over a shell's text.
  const docOf = (html: string) => ({
    querySelector: (sel: string) => {
      const name = /^meta\[name="([^"]+)"\]$/.exec(sel)?.[1]
      const m = name ? new RegExp(`<meta name="${name}" content="([^"]*)">`).exec(html) : null
      return (m ? { getAttribute: (a: string) => (a === 'content' ? m[1] : null) } : null) as any
    },
  })

  it('a master marks its shell, once, and only a master does', () => {
    const master = portalShellFor(shell, 'master')
    expect(master.split(MASTER_NODE_TAG).length).toBe(2)
    expect(portalShellFor(master, 'master')).toBe(master)
    expect(portalShellFor(shell, 'global')).not.toContain(MASTER_NODE_TAG)
  })

  it('the portal reads the very tag the server writes', () => {
    expect(UI_MASTER_NODE_TAG).toBe(MASTER_NODE_TAG)
    expect(servedByMaster(docOf(portalShellFor(shell, 'master')))).toBe(true)
  })

  it('lgrai.app, a development page, or no document at all is not a master', () => {
    expect(servedByMaster(docOf(portalShellFor(shell, 'global')))).toBe(false)
    expect(servedByMaster(docOf(shell))).toBe(false)
    expect(servedByMaster(docOf('<head><meta name="lgr-node" content="global"></head>'))).toBe(false)
    expect(servedByMaster(undefined)).toBe(false)
  })
})

describe('CLOUD_SECRET_NAMES is the sealed secrets\' key list', () => {
  const sealed = join(REPO_ROOT, '..', 'lgr-deploy', 'k8s', 'base', 'sealed')
  it.skipIf(!existsSync(sealed))('matches lgr-deploy\'s sealed secrets when it is checked out beside this repository', () => {
    const keys = new Set<string>()
    for (const f of ['sealed-lgr-secret.yaml', 'sealed-mongodb-secret.yaml', 'sealed-ocr-secret.yaml']) {
      // The keys are the lines indented under `encryptedData:`, up to the next sibling (`template:`).
      const lines = readFileSync(join(sealed, f), 'utf8').split(/\r?\n/)
      let inData = false
      for (const line of lines) {
        if (/^\s*encryptedData:\s*$/.test(line)) { inData = true; continue }
        if (!inData) continue
        const key = line.match(/^ {4}([A-Za-z0-9_]+):/)
        if (key) keys.add(key[1])
        else if (/^ {0,2}\S/.test(line)) inData = false
      }
    }
    expect([...CLOUD_SECRET_NAMES].sort()).toEqual([...keys].sort())
  })
})
