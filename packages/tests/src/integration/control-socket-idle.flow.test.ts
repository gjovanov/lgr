import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startControlSocket } from '../../../portal-api/src/front/control-socket'

/**
 * The control socket's slow answers. Bun closes a connection idle for 10 s (at ~12 s, its timer ticks
 * every 4), and `server.timeout()` does nothing on a unix socket: a backup that took longer came back
 * empty, so a master whose backup takes longer never switched versions (`helper.rs`: no backup, no
 * switch). A lane on the published 0.1.7 found it, after a cold boot on a loaded host.
 *
 * The client is the supervisor's (`packages/server/src/control.rs`): HTTP/1.1, one request per
 * connection, read to EOF. A cut is what it saw there: EOF and no headers.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const SECRET = 'control-socket-idle-secret'
const HELD_MS = 13_000

describe('the control socket: an answer slower than Bun\'s idle limit', () => {
  let dir: string
  let socket: string
  let ctl: { close: () => void }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lgr-control-'))
    socket = join(dir, 'api.sock')
    ctl = startControlSocket(socket, SECRET, {
      status: () => ({ ok: true }),
      stop: () => {},
      backup: async () => {
        await Bun.sleep(HELD_MS)
        return { ok: true, runs: [] }
      },
      replication: {
        status: async () => ({}),
        page: async () => {
          await Bun.sleep(HELD_MS)
          return { status: 204 }
        },
        resend: async () => ({ journaled: 0 }),
        blob: async () => {
          await Bun.sleep(HELD_MS)
          return { status: 404, code: 'not_here', detail: 'not here' }
        },
      },
    })
  })

  afterAll(() => {
    ctl.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Everything the socket sent before it closed. */
  const post = (path: string, body = '') =>
    new Promise<string>(resolve => {
      let raw = ''
      const s = connect(socket, () =>
        s.write(`POST ${path} HTTP/1.1\r\nHost: lgr-api\r\nx-lgr-front: ${SECRET}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`),
      )
      s.on('data', d => { raw += d.toString() })
      s.on('close', () => resolve(raw))
      s.on('error', () => resolve(raw))
    })

  it('a backup, a mirror page and a file chunk are each answered, however long they took', async () => {
    const [backup, page, blob] = await Promise.all([post('/backup'), post('/replication/page', '{}'), post('/replication/blob', '{}')])
    expect(backup.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    expect(backup).toContain('"ok":true')
    expect(page.split('\r\n')[0]).toBe('HTTP/1.1 204 No Content')
    expect(blob.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found')
    expect(blob).toContain('not_here')
  }, 30_000)
})
