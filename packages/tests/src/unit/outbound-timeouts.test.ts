import { describe, it, expect, afterAll } from 'bun:test'
import { Glob } from 'bun'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { fetchWithTimeout, OutboundTimeoutError } from 'services/biz/outbound-fetch'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * Every outbound call has a deadline (FR-20.53, plan step P0a-7).
 *
 * The failure this guards against is not a refused connection — that fails fast on its own — but
 * a host that ACCEPTS and then never answers: a black-holed address, a stalled proxy. These tests
 * use exactly that, a TCP server that takes the connection and says nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const sockets: any[] = []
/** Accepts connections and never writes a byte. */
const blackHole = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: { open(s) { sockets.push(s) }, data() {} },
})
/** Sends a response head, then whatever `body` decides, slowly. */
function slowServer(chunks: string[], gapMs: number) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      const stream = new ReadableStream({
        async start(c) {
          for (const chunk of chunks) {
            await new Promise(r => setTimeout(r, gapMs))
            c.enqueue(new TextEncoder().encode(chunk))
          }
          c.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/plain' } })
    },
  })
}
const servers: any[] = []
afterAll(() => {
  blackHole.stop(true)
  for (const s of servers) s.stop(true)
})

describe('fetchWithTimeout', () => {
  it('a host that accepts and never answers fails within the deadline, naming it', async () => {
    const started = Date.now()
    const err = await captureRejection(fetchWithTimeout(`http://127.0.0.1:${blackHole.port}/x`, {}, { timeoutMs: 300 }))
    expect(err).toBeInstanceOf(OutboundTimeoutError)
    expect((err as Error).message).toContain(`127.0.0.1:${blackHole.port}`)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('the default deadline covers the body: a response that stalls mid-body fails too', async () => {
    const server = slowServer(['a', 'b', 'c'], 400)
    servers.push(server)
    const res = await fetchWithTimeout(`http://127.0.0.1:${server.port}/`, {}, { timeoutMs: 600 })
    const err = await captureRejection(res.text())
    expect(err).toBeTruthy()
  })

  it('`until: headers` bounds only the wait for the response — a slow, healthy stream is never cut off', async () => {
    const server = slowServer(['a', 'b', 'c', 'd'], 250) // ~1 s of body against a 400 ms deadline
    servers.push(server)
    const res = await fetchWithTimeout(`http://127.0.0.1:${server.port}/`, {}, { timeoutMs: 400, until: 'headers' })
    expect(await res.text()).toBe('abcd')
  })

  it('`until: headers` still fails a host that never answers', async () => {
    const err = await captureRejection(fetchWithTimeout(`http://127.0.0.1:${blackHole.port}/x`, {}, { timeoutMs: 300, until: 'headers' }))
    expect(err).toBeInstanceOf(OutboundTimeoutError)
  })

  it('a fast answer is untouched, and the caller\'s own signal still cancels', async () => {
    const server = slowServer(['ok'], 0)
    servers.push(server)
    expect(await (await fetchWithTimeout(`http://127.0.0.1:${server.port}/`, {}, { timeoutMs: 2000 })).text()).toBe('ok')

    const mine = new AbortController()
    const pending = fetchWithTimeout(`http://127.0.0.1:${blackHole.port}/x`, { signal: mine.signal }, { timeoutMs: 10_000 })
    mine.abort()
    const err = await captureRejection(pending)
    expect(err).toBeTruthy()
    expect(err).not.toBeInstanceOf(OutboundTimeoutError)
  })

  it('an injected fetch is the one called', async () => {
    let called = 0
    const fake = async () => { called++; return new Response('fake') }
    const res = await fetchWithTimeout('https://example.invalid/', {}, { timeoutMs: 1000, fetchImpl: fake as any })
    expect(await res.text()).toBe('fake')
    expect(called).toBe(1)
  })
})

/**
 * `line: text` of every `fetch(` whose own call — up to its matching `)` — names no signal and does
 * not go through fetchWithTimeout. Read by parentheses, not by a window of lines: a window would
 * credit an untimed call with the deadline of the next one.
 */
function untimedCalls(source: string): string[] {
  const hits: string[] = []
  const call = /(^|[^A-Za-z_$])((?:[a-z]\.)?fetch)\(/g
  let m: RegExpExecArray | null
  while ((m = call.exec(source))) {
    const start = m.index + m[1].length
    const lineStart = source.lastIndexOf('\n', start) + 1
    const lineText = source.slice(lineStart, source.indexOf('\n', start) === -1 ? undefined : source.indexOf('\n', start))
    // Comments mention fetch( too.
    if (/^\s*(\*|\/\/)/.test(lineText) || /\/\/.*fetch\(/.test(lineText.slice(0, start - lineStart + 6))) continue
    let depth = 0
    let i = source.indexOf('(', start)
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')' && --depth === 0) break
    }
    if (!/signal|fetchWithTimeout/.test(source.slice(start, i + 1))) {
      hits.push(`${source.slice(0, start).split('\n').length}: ${lineText.trim()}`)
    }
  }
  return hits
}

describe('no outbound call in server code goes without a deadline', () => {
  it('the scan can see one (positive control)', () => {
    const sample = ['const a = await fetch(url, {', '  method: \'POST\',', '})', 'const b = await d.fetch(url, { signal: AbortSignal.timeout(5) })', '// fetch( in a comment', 'const c = await fetchWithTimeout(url, {}, { timeoutMs: 1 })'].join('\n')
    expect(untimedCalls(sample)).toEqual(['1: const a = await fetch(url, {'])
  })

  it('every fetch( in server packages carries a signal or goes through fetchWithTimeout', async () => {
    const root = join(import.meta.dir, '..', '..', '..')
    const dirs = ['services/src', 'portal-api/src', 'fiscal/src', 'reporting/src', 'migrations/src', 'config/src']
    for await (const p of new Glob('*-api/src').scan({ cwd: root, onlyFiles: false })) dirs.push(p)
    const offenders: string[] = []
    for (const dir of new Set(dirs)) {
      if (!existsSync(join(root, dir))) continue
      for await (const f of new Glob('**/*.ts').scan({ cwd: join(root, dir) })) {
        if (f.endsWith('outbound-fetch.ts')) continue
        for (const hit of untimedCalls(await Bun.file(join(root, dir, f)).text())) offenders.push(`${dir}/${f}:${hit}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
