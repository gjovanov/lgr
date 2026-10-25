import { describe, it, expect } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLISHED_EXAMPLE_SECRETS } from 'config'

/**
 * #157, FR-20.17 — production refuses every secret value this repository publishes as an
 * example, and FR-20.1's node role.
 *
 * The example values are long enough to pass the length check, so the presence/fallback/length
 * rules of S-02 let them through: a deployment that copied `.env.example` or the compose file
 * unchanged signed every token with a key anyone can read.
 *
 * Boot is tested for real: a child `bun` imports `config` with the environment under test, since
 * the check runs at import and the module cannot be re-imported in-process.
 */

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const SECRETISH = /(SECRET|TOKEN|PASSWORD|_KEY)$/
const sha = (v: string) => createHash('sha256').update(v.trim()).digest('hex')

/** Every non-empty secret-like value the example and compose files publish, with where. */
function publishedValues(): Array<{ value: string; where: string }> {
  const out: Array<{ value: string; where: string }> = []
  const add = (value: string, where: string) => { if (value.trim()) out.push({ value: value.trim(), where }) }
  for (const line of readFileSync(join(ROOT, '.env.example'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*#?\s*([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m && SECRETISH.test(m[1])) add(m[2].replace(/^["']|["']$/g, ''), `.env.example ${m[1]}`)
  }
  for (const m of readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8').matchAll(/\$\{([A-Z0-9_]+):-([^}]*)\}/g)) {
    if (SECRETISH.test(m[1])) add(m[2], `docker-compose.yml ${m[1]}`)
  }
  for (const m of readFileSync(join(ROOT, 'deploy/ocr/ocr-secret.example.yaml'), 'utf8').matchAll(/^\s+([A-Z0-9_]+):\s*"([^"]*)"/gm)) {
    if (SECRETISH.test(m[1])) add(m[2], `ocr-secret.example.yaml ${m[1]}`)
  }
  return out
}

function exampleValue(name: string): string {
  const v = publishedValues().find(p => p.where === `.env.example ${name}`)
  if (!v) throw new Error(`.env.example has no ${name}`)
  return v.value
}

const strong = () => randomBytes(36).toString('base64')

/** Import `config` in a fresh process. Exit 0 and what it printed, or the error. */
async function boot(env: Record<string, string>, expr = 'm.config.node.role') {
  const proc = Bun.spawn([process.execPath, '-e', `const m = await import('config'); console.log(${expr})`], {
    cwd: join(import.meta.dir, '..', '..'),
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: out.trim(), err }
}

describe('published example secrets (#157)', () => {
  it('every secret value in the example and compose files is on the refusal list', () => {
    const values = publishedValues()
    // The files do publish some: if this ever reads none, the parsing above broke, not the rule.
    expect(values.length).toBeGreaterThanOrEqual(3)
    const missing = values.filter(v => !(sha(v.value) in PUBLISHED_EXAMPLE_SECRETS)).map(v => v.where)
    expect(missing).toEqual([])
  })

  it('the list holds hashes, never the values themselves', () => {
    for (const k of Object.keys(PUBLISHED_EXAMPLE_SECRETS)) expect(k).toMatch(/^[0-9a-f]{64}$/)
    const source = readFileSync(join(ROOT, 'packages/config/src/index.ts'), 'utf8')
    for (const v of publishedValues()) expect(source.includes(v.value)).toBe(false)
  })

  it('production refuses the published JWT_SECRET, and names where it is published', async () => {
    const r = await boot({ NODE_ENV: 'production', JWT_SECRET: exampleValue('JWT_SECRET'), DESKTOP_TOKEN_SECRET: strong(), NODE_TOKEN_SECRET: strong() })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('JWT_SECRET is the example value published in')
    expect(r.err).toContain('.env.example')
  }, 30_000)

  it('production refuses the published DESKTOP_TOKEN_SECRET', async () => {
    const r = await boot({ NODE_ENV: 'production', JWT_SECRET: strong(), DESKTOP_TOKEN_SECRET: exampleValue('DESKTOP_TOKEN_SECRET'), NODE_TOKEN_SECRET: strong() })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('DESKTOP_TOKEN_SECRET is the example value published in')
  }, 30_000)

  it('production starts with generated secrets; development accepts the examples', async () => {
    expect((await boot({ NODE_ENV: 'production', JWT_SECRET: strong(), DESKTOP_TOKEN_SECRET: strong(), NODE_TOKEN_SECRET: strong() })).code).toBe(0)
    expect((await boot({ NODE_ENV: 'development', JWT_SECRET: exampleValue('JWT_SECRET'), DESKTOP_TOKEN_SECRET: exampleValue('DESKTOP_TOKEN_SECRET') })).code).toBe(0)
  }, 30_000)
})

describe('the node token secret (FR-20.2)', () => {
  it('global refuses to start in production without one; a master needs none', async () => {
    const global = await boot({ NODE_ENV: 'production', JWT_SECRET: strong(), DESKTOP_TOKEN_SECRET: strong() })
    expect(global.code).not.toBe(0)
    expect(global.err).toContain('NODE_TOKEN_SECRET is not set')
    const short = await boot({ NODE_ENV: 'production', JWT_SECRET: strong(), DESKTOP_TOKEN_SECRET: strong(), NODE_TOKEN_SECRET: 'too-short' })
    expect(short.err).toContain('NODE_TOKEN_SECRET is 9 characters')
    const master = await boot({ NODE_ENV: 'production', JWT_SECRET: strong(), DESKTOP_TOKEN_SECRET: strong(), LGR_NODE_ROLE: 'master' }, 'JSON.stringify(m.config.node.tokenSecret)')
    expect({ code: master.code, out: master.out }).toEqual({ code: 0, out: '""' })
  }, 30_000)
})

describe('node role (FR-20.1)', () => {
  it('is global by default, master when asked, and refuses anything else', async () => {
    expect((await boot({})).out).toBe('global')
    expect((await boot({ LGR_NODE_ROLE: 'master' })).out).toBe('master')
    const typo = await boot({ LGR_NODE_ROLE: 'mastr' })
    expect(typo.code).not.toBe(0)
    expect(typo.err).toContain('LGR_NODE_ROLE must be')
  }, 30_000)

  it('nodeRole() answers from config, and the node id is optional', async () => {
    expect((await boot({ LGR_NODE_ROLE: 'master', LGR_NODE_ID: 'node-7' }, '`${m.nodeRole()}:${m.config.node.id}`')).out).toBe('master:node-7')
    expect((await boot({}, 'String(m.config.node.id)')).out).toBe('undefined')
  }, 30_000)
})
