import { describe, it, expect, afterEach } from 'bun:test'
import { credentialStatus } from '../src/draft'

/**
 * ⚠ An env var sourced from a Secret key that is absent or EMPTY arrives as `''` — falsy, and
 * invisible in a log. regal's sidecar ran for eight days (2026-10-15 … 23) with an empty
 * CLAUDE_CODE_OAUTH_TOKEN and no ANTHROPIC_API_KEY (`optional: true`, absent), so every /draft
 * spawned an unauthenticated `claude`, got `exited 1: no stderr`, and returned a bare 502 —
 * while /health reported the service perfectly fine.
 */
describe('credentialStatus', () => {
  const saved = { oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, api: process.env.ANTHROPIC_API_KEY, home: process.env.HOME, up: process.env.USERPROFILE }
  afterEach(() => {
    for (const [k, v] of [['CLAUDE_CODE_OAUTH_TOKEN', saved.oauth], ['ANTHROPIC_API_KEY', saved.api], ['HOME', saved.home], ['USERPROFILE', saved.up]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  })

  /** Point HOME at somewhere with no ~/.claude/.credentials.json, so only env vars count. */
  function isolateHome() {
    process.env.HOME = '/nonexistent-home-for-tests'
    process.env.USERPROFILE = 'C:\nonexistent-home-for-tests'
  }

  it('treats an EMPTY token exactly like a missing one, and says so', () => {
    isolateHome()
    process.env.CLAUDE_CODE_OAUTH_TOKEN = ''
    delete process.env.ANTHROPIC_API_KEY
    const s = credentialStatus()
    expect(s.usable).toBe(false)
    expect(s.oauth).toBe(false)
    expect(s.detail).toContain('EMPTY')
    expect(s.detail).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(s.detail).toContain('ANTHROPIC_API_KEY')
  })

  it('is usable on the OAuth token alone, and names it', () => {
    isolateHome()
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-not-a-real-token'
    delete process.env.ANTHROPIC_API_KEY
    const s = credentialStatus()
    expect(s.usable).toBe(true)
    expect(s.oauth).toBe(true)
    expect(s.detail).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('is usable on the API key alone — the fallback the outage lacked', () => {
    isolateHome()
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-real-key'
    const s = credentialStatus()
    expect(s.usable).toBe(true)
    expect(s.apiKey).toBe(true)
  })

  it('never puts a credential VALUE in the detail it reports', () => {
    isolateHome()
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-SECRET-VALUE'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-SECRET-VALUE'
    const s = credentialStatus()
    expect(s.detail).not.toContain('SECRET-VALUE')
  })
})

/**
 * ⚠ The CLI writes its diagnosis to STDOUT, not stderr: on failure it still prints its
 * `--output-format json` envelope, then exits non-zero with stderr EMPTY. Reporting only the exit
 * code threw that away — regal's imports failed as `claude exited 1: no stderr` for eight days
 * while the envelope had been saying `429 — "You've hit your weekly limit"` the whole time.
 */
describe('claudeEnvelopeError', () => {
  it('surfaces the real reason from a failing envelope — status and message', async () => {
    const { claudeEnvelopeError } = await import('../src/draft')
    const envelope = {
      is_error: true,
      api_error_status: 429,
      terminal_reason: 'api_error',
      result: "You've hit your weekly limit · resets 4am (UTC)",
      usage: { output_tokens: 0 },
    }
    const msg = claudeEnvelopeError(envelope)
    expect(msg).toContain('429')
    expect(msg).toContain('weekly limit')
  })

  it('returns null for a successful envelope, so the result is used as-is', async () => {
    const { claudeEnvelopeError } = await import('../src/draft')
    expect(claudeEnvelopeError({ is_error: false, result: '{"x":1}' })).toBeNull()
    expect(claudeEnvelopeError(null)).toBeNull()
  })

  it('falls back to terminal_reason when there is no human message', async () => {
    const { claudeEnvelopeError } = await import('../src/draft')
    expect(claudeEnvelopeError({ is_error: true, terminal_reason: 'api_error' })).toContain('api_error')
  })

  it('⚠ an envelope flagged is_error must fail even on exit code 0', async () => {
    // The CLI has been observed exiting 0 while reporting is_error — passing `result` on to the
    // JSON parser then fails as "no JSON object in model output", hiding the real cause.
    const { claudeEnvelopeError } = await import('../src/draft')
    expect(claudeEnvelopeError({ is_error: true, api_error_status: 429, result: 'limit' })).not.toBeNull()
  })
})
