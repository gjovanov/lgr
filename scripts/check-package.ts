#!/usr/bin/env bun
/**
 * `bun run check:package [<dir>]` — may this server package ship? (FR-20.26, plan step P0b-9;
 * AC 21, 66, 67). `<dir>` defaults to `dist/lgr-server`, what `build:server` writes.
 *
 * Refuses a package that:
 *   - holds a file its manifest does not list, lists one it does not hold, or holds one whose
 *     bytes differ from the manifest's: it contains only what it lists;
 *   - holds a path the repository ignores (`.gitignore`: uploads, logs, exports, `.env`, `.secrets/`);
 *   - holds `.secrets/`, a `*.seal.key` or an `.env*` file, whatever `.gitignore` says;
 *   - names a cloud secret (`CLOUD_SECRET_NAMES`) in a file it carries. In a server bundle, where
 *     the config reads those names from its environment, only a name given a VALUE counts;
 *   - makes a built SPA load a script, a style, a font or a beacon from another origin (AC 66);
 *   - carries a script that can write an issued document, judged from its source and everything
 *     it imports in the repository (AC 67);
 *   - was bundled with `process.env.NODE_ENV` inlined, which compiles every production guard out.
 *
 * Prints every finding and exits 1, or exits 0 when there are none. The script check reads the
 * repository, so it runs where the package was built (CI), at the manifest's commit.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  CLOUD_SECRET_NAMES, ISSUED_DOCUMENT_COLLECTIONS, ISSUED_DOCUMENT_MODELS, MANIFEST, NEVER_PACKAGED, REPO_ROOT,
  describeFile, listFiles, type ServerManifest,
} from './lib/server-package.ts'

export interface Finding {
  rule: 'manifest' | 'gitignored' | 'secret-file' | 'secret-name' | 'foreign-origin' | 'script' | 'node-env'
  path: string
  detail: string
}

// ── secret names ───────────────────────────────────────────────────────────────────────────────

const NAMES = CLOUD_SECRET_NAMES.join('|')
const NAMED = new RegExp(`\\b(${NAMES})\\b`, 'g')
/**
 * A name given a literal value: `JWT_SECRET=...` (an env file), `"JWT_SECRET": "..."` or
 * `JWT_SECRET: '...'` (a config object). `JWT_SECRET: process.env.JWT_SECRET` is the config reading
 * its environment and is not one: the value has to be a quoted literal or the rest of an env line.
 */
const ASSIGNED = new RegExp(
  `(?:^|[\\s{,;(])["'\`]?(${NAMES})["'\`]?\\s*(?:=\\s*(?!process\\.env|Bun\\.env|import\\.meta)["'\`]?[^\\s"'\`;,)]{4,}|:\\s*["'\`][^"'\`]{4,}["'\`])`,
  'gm',
)

/** Is `path` one of the package's server bundles (`app/**.js`)? There the names are config reads. */
const isServerBundle = (path: string) => path.startsWith('app/') && path.endsWith('.js')

export function secretNameHits(path: string, text: string): string[] {
  const hits = new Set<string>()
  if (isServerBundle(path)) {
    for (const m of text.matchAll(ASSIGNED)) hits.add(`${m[1]} is given a value`)
  } else {
    for (const m of text.matchAll(NAMED)) hits.add(`names ${m[1]}`)
  }
  return [...hits]
}

// ── other origins in a built SPA (AC 66) ──────────────────────────────────────────────────────

const ABSOLUTE = String.raw`(?:https?:)?\/\/[^\s"'<>)\`]+`
const HTML_URL = new RegExp(String.raw`\b(?:src|href|data|action|poster|srcset|content)\s*=\s*["']?\s*(?:\d+\s*;\s*url=)?(${ABSOLUTE})`, 'gi')
const CSS_URL = new RegExp(String.raw`(?:url\(\s*["']?|@import\s+["'])(${ABSOLUTE})`, 'gi')
/** A script that LOADS something from an origin given as a literal. */
const JS_LOAD = new RegExp(
  String.raw`(?:import\(|importScripts\(|new\s+(?:Shared)?Worker\(|sendBeacon\(|\.src\s*=|setAttribute\(\s*["'](?:src|href)["']\s*,)\s*["'\`](${ABSOLUTE})`,
  'g',
)
/**
 * Hosts whose name alone in a bundle means a third-party script, style, font or beacon: analytics,
 * tag managers, script CDNs, hosted fonts, payment and captcha widgets. A link to a documentation
 * site in a library's error message is none of these, so it is not refused.
 */
const THIRD_PARTY_HOSTS = new RegExp(
  String.raw`\b(purestat\.ai|googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net|` +
    String.raw`connect\.facebook\.net|js\.stripe\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|` +
    String.raw`fonts\.googleapis\.com|fonts\.gstatic\.com|sentry-cdn\.com|ingest\.sentry\.io|plausible\.io|` +
    String.raw`cdn\.segment\.com|hotjar\.com|clarity\.ms|google\.com\/recaptcha|challenges\.cloudflare\.com)\b`,
  'gi',
)

export function foreignOriginHits(path: string, text: string): string[] {
  const hits = new Set<string>()
  const lower = path.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) for (const m of text.matchAll(HTML_URL)) hits.add(`loads ${m[1]}`)
  if (lower.endsWith('.css') || lower.endsWith('.html')) for (const m of text.matchAll(CSS_URL)) hits.add(`loads ${m[1]}`)
  if (/\.(m?js|html)$/.test(lower)) for (const m of text.matchAll(JS_LOAD)) hits.add(`loads ${m[1]}`)
  if (/\.(m?js|css|html|json|webmanifest)$/.test(lower)) for (const m of text.matchAll(THIRD_PARTY_HOSTS)) hits.add(`refers to ${m[1].toLowerCase()}`)
  return [...hits]
}

// ── scripts that write issued documents (AC 67) ───────────────────────────────────────────────

const MODELS_MODULE = /(^|\/)db\/(src\/)?models(\/index(\.[jt]s)?|\/[a-z0-9-]+\.model(\.[jt]s)?)?$/
const IMPORT_SPECS = /(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g
const FORBIDDEN_MODEL = new RegExp(`\\b(${ISSUED_DOCUMENT_MODELS.join('|')})\\b`)
const FORBIDDEN_COLLECTION = new RegExp(`["'\`](${ISSUED_DOCUMENT_COLLECTIONS.join('|')})["'\`]`)
const DYNAMIC_MODEL = new RegExp(`\\bmodels?\\s*(?:\\(|\\[|\\.)\\s*["'\`]?(${ISSUED_DOCUMENT_MODELS.join('|')})\\b`)

/** `config`, `db/models`, `services/biz/x` → the workspace file, as the packages' `exports` map them. */
function resolveImport(spec: string, from: string, repo: string): string | null {
  const candidates = (base: string) => [base, `${base}.ts`, base.replace(/\.js$/, '.ts'), join(base, 'index.ts')]
  let base: string | null = null
  if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else {
    const [pkg, ...rest] = spec.split('/')
    if (!pkg || pkg.startsWith('@') || !existsSync(join(repo, 'packages', pkg, 'package.json'))) return null
    base = join(repo, 'packages', pkg, 'src', rest.length ? rest.join('/') : 'index')
  }
  for (const c of candidates(base)) if (existsSync(c) && !c.endsWith(sep) && /\.[jt]s$/.test(c)) return c
  return null
}

/**
 * Every way `script` (a path in the repository) could write an issued document, from its source and
 * the source of everything it imports from the repository: an issued-document model imported from
 * the models, a model looked up by that name, or a raw collection named like one. Reading one is
 * refused too, since a static check cannot tell a read from a write: a script that needs to read
 * invoices stays in the repository.
 *
 * The models themselves are not descended into: they define every model and write none.
 */
export function issuedDocumentHits(script: string, repo: string = REPO_ROOT): string[] {
  const hits = new Set<string>()
  const seen = new Set<string>()
  const queue = [resolve(script)]
  while (queue.length) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    const where = relative(repo, file).split(sep).join('/')
    const collection = src.match(FORBIDDEN_COLLECTION)
    if (collection) hits.add(`${where} names the ${collection[1]} collection`)
    const dynamic = src.match(DYNAMIC_MODEL)
    if (dynamic) hits.add(`${where} looks up the ${dynamic[1]} model by name`)
    for (const m of src.matchAll(IMPORT_SPECS)) {
      const [, bindings, fromSpec, dynSpec, reqSpec, bareSpec] = m
      const spec = fromSpec ?? dynSpec ?? reqSpec ?? bareSpec
      const target = resolveImport(spec, file, repo)
      const targetRel = target ? relative(repo, target).split(sep).join('/') : spec
      if (MODELS_MODULE.test(spec) || MODELS_MODULE.test(targetRel.replace(/^packages\//, '').replace(/\.ts$/, ''))) {
        if (bindings && /^\s*\*/.test(bindings)) hits.add(`${where} imports every model (\`import *\`), which cannot be checked`)
        const named = bindings ? bindings.match(FORBIDDEN_MODEL) : null
        if (named) hits.add(`${where} imports ${named[1]}`)
        continue // a model file defines models; it is not followed
      }
      if (target && !seen.has(target)) queue.push(target)
    }
  }
  return [...hits]
}

// ── the package ────────────────────────────────────────────────────────────────────────────────

/** Package paths the repository's `.gitignore` excludes. Global and per-clone excludes are not consulted. */
export function gitIgnored(paths: string[], repo: string = REPO_ROOT): string[] {
  if (!paths.length) return []
  const r = Bun.spawnSync(['git', '-c', 'core.excludesFile=', 'check-ignore', '--no-index', '--stdin'], {
    cwd: repo,
    stdin: new TextEncoder().encode(paths.join('\n') + '\n'),
  })
  if (r.exitCode !== 0 && r.exitCode !== 1) throw new Error(`git check-ignore failed: ${r.stderr.toString()}`)
  return r.stdout.toString().split('\n').map(s => s.trim()).filter(Boolean)
}

export function checkPackage(dir: string, opts: { repo?: string } = {}): Finding[] {
  const repo = opts.repo ?? REPO_ROOT
  const findings: Finding[] = []
  const add = (rule: Finding['rule'], path: string, detail: string) => findings.push({ rule, path, detail })

  const manifestPath = join(dir, MANIFEST)
  if (!existsSync(manifestPath)) {
    add('manifest', MANIFEST, 'missing: this is not a package `build:server` wrote')
    return findings
  }
  let manifest: ServerManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    add('manifest', MANIFEST, 'is not JSON')
    return findings
  }

  const onDisk = listFiles(dir).filter(p => p !== MANIFEST)
  const listed = new Map((manifest.files ?? []).map(f => [f.path, f]))
  for (const path of onDisk) {
    const want = listed.get(path)
    if (!want) add('manifest', path, 'is not in the manifest')
    else {
      const got = describeFile(dir, path)
      if (got.sha256 !== want.sha256 || got.size !== want.size) add('manifest', path, 'differs from the manifest')
    }
  }
  const present = new Set(onDisk)
  for (const path of listed.keys()) if (!present.has(path)) add('manifest', path, 'is in the manifest but not in the package')

  for (const path of gitIgnored(onDisk, repo)) add('gitignored', path, 'is a path the repository ignores')

  for (const path of onDisk) {
    const segments = path.split('/')
    const base = segments[segments.length - 1]
    if (segments.includes('.secrets')) add('secret-file', path, 'is under .secrets/')
    else if (/\.seal\.key$/i.test(base) || base === 'lgr-seal.key') add('secret-file', path, 'is a backup seal key')
    else if (/^\.env/i.test(base)) add('secret-file', path, 'is an env file')
  }

  for (const path of onDisk) {
    // latin1 reads every byte as one character, so a binary file is scanned too, and cheaply.
    const text = readFileSync(join(dir, path), 'latin1')
    for (const hit of secretNameHits(path, text)) add('secret-name', path, hit)
    if (path.startsWith('ui/')) for (const hit of foreignOriginHits(path, text)) add('foreign-origin', path, hit)
  }

  const packagedScripts = onDisk.filter(p => /^app\/scripts\/[^/]+\.js$/.test(p)).map(p => p.slice('app/scripts/'.length, -3))
  for (const name of packagedScripts) if (!(manifest.scripts ?? []).includes(name)) add('script', `app/scripts/${name}.js`, 'is not in the manifest\'s scripts')
  for (const name of manifest.scripts ?? []) {
    const path = `app/scripts/${name}.js`
    if ((NEVER_PACKAGED as readonly string[]).includes(name)) add('script', path, 'changes issued documents and never leaves the repository')
    const source = join(repo, 'scripts', `${name}.ts`)
    if (!existsSync(source)) {
      add('script', path, `has no source (scripts/${name}.ts) in the repository to vet it against`)
      continue
    }
    for (const hit of issuedDocumentHits(source, repo)) add('script', path, hit)
  }

  for (const entry of Object.values(manifest.entries ?? {})) {
    if (!present.has(entry)) continue
    if (!readFileSync(join(dir, entry), 'utf8').includes('process.env.NODE_ENV')) {
      add('node-env', entry, 'was bundled with NODE_ENV inlined, which compiles every production guard out')
    }
  }
  return findings
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? join(REPO_ROOT, 'dist', 'lgr-server'))
  const findings = checkPackage(dir)
  for (const f of findings) console.log(`${f.rule.padEnd(15)} ${f.path}: ${f.detail}`)
  if (findings.length) {
    console.log(`\n${findings.length} finding(s): ${dir} may not ship.`)
    process.exit(1)
  }
  console.log(`${dir}: nothing found. It may ship.`)
}
