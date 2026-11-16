import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'

/**
 * The tab's session is built on first use. A first use with no window (server code, or another test file run first in
 * the same process) built one with no storage, and it was kept: every later `setSession` was dropped. The FR-27 access
 * tests that install a window failed whenever a file before them did that, which is the order mars ran them in on
 * 2026-11-11 and not CI's. It is built again once a window exists.
 *
 * In a process of its own, so no other file's first use decides it.
 */

const UNIT = import.meta.dir

const script = `
import { claims, setSession } from 'ui-shared/session/session'
if (claims() !== null) throw new Error('a session with no window holds nothing')
class Mem { m = new Map(); getItem(k) { return this.m.has(k) ? this.m.get(k) : null } setItem(k, v) { this.m.set(k, v) } removeItem(k) { this.m.delete(k) } }
globalThis.window = { sessionStorage: new Mem(), localStorage: new Mem(), addEventListener() {}, location: { pathname: '/' } }
globalThis.document = { addEventListener() {}, visibilityState: 'visible' }
const token = 'h.' + btoa(JSON.stringify({ id: 'u1', orgId: 'o1', role: 'seller', exp: 4102444800 })).replace(/=+$/, '') + '.s'
setSession(token, { id: 'o1', slug: 'o1', name: 'O1' })
console.log(JSON.stringify({ orgId: claims()?.orgId ?? null, stored: window.sessionStorage.getItem('lgr_token') === token }))
process.exit(0)
`

describe('the tab session', () => {
  it('first used with no window, is built again once a window exists, and keeps what is set', () => {
    const r = Bun.spawnSync([process.execPath, '-e', script], { cwd: join(UNIT, '..', '..'), stdout: 'pipe', stderr: 'pipe' })
    expect(r.stderr.toString()).toBe('')
    expect(JSON.parse(r.stdout.toString().trim())).toEqual({ orgId: 'o1', stored: true })
  })
})
