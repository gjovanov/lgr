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
    process.env.USERPROFILE = 'C:\\nonexistent-home-for-tests'
  }

  it('treats an EMPTY token exactly like a missing one, and says so', () => {
    isolateHome()
    process.env.CLAUDE_CODE_OAUTH_TOKEN = ''
    delete process.env.CLAUDE_CODE_OAUTH_TOKENS
    delete process.env.ANTHROPIC_API_KEY
    const s = credentialStatus()
    expect(s.usable).toBe(false)
    expect(s.oauth).toBe(false)
    expect(s.detail).toContain('EMPTY')
    expect(s.detail).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(s.detail).toContain('ANTHROPIC_API_KEY')
  })

  it('is usable on the OAuth token alone, and counts it', () => {
    isolateHome()
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-fixture-single'
    delete process.env.CLAUDE_CODE_OAUTH_TOKENS
    delete process.env.ANTHROPIC_API_KEY
    const s = credentialStatus()
    expect(s.usable).toBe(true)
    expect(s.oauth).toBe(true)
    expect(s.subscriptions).toBe(1)
    expect(s.detail).toContain('1 subscription token(s)')
  })

  it('is usable on the API key alone — the fallback the outage lacked', () => {
    isolateHome()
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.CLAUDE_CODE_OAUTH_TOKENS
    process.env.ANTHROPIC_API_KEY = 'apikey-fixture'
    const s = credentialStatus()
    expect(s.usable).toBe(true)
    expect(s.apiKey).toBe(true)
  })

  it('never puts a credential VALUE in the detail it reports', () => {
    isolateHome()
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-fixture-MUST-NOT-LEAK'
    process.env.ANTHROPIC_API_KEY = 'apikey-fixture-MUST-NOT-LEAK'
    const s = credentialStatus()
    expect(s.detail).not.toContain('MUST-NOT-LEAK')
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

/**
 * A Max subscription's limit is WEEKLY, so a single exhausted account stops imports for days.
 * Several accounts are accepted and tried in order; a 429 advances to the next one and is
 * remembered, so the next document does not spend a spawn re-learning it.
 */
describe('subscription rotation', () => {
  const saved = { one: process.env.CLAUDE_CODE_OAUTH_TOKEN, many: process.env.CLAUDE_CODE_OAUTH_TOKENS }
  afterEach(() => {
    for (const [k, v] of [['CLAUDE_CODE_OAUTH_TOKEN', saved.one], ['CLAUDE_CODE_OAUTH_TOKENS', saved.many]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  })

  it('reads a pool from CLAUDE_CODE_OAUTH_TOKENS, newline or comma separated', async () => {
    const { oauthTokens } = await import('../src/draft')
    process.env.CLAUDE_CODE_OAUTH_TOKENS = 'oauth-fixture-a\noauth-fixture-b,oauth-fixture-c'
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    expect(oauthTokens()).toEqual(['oauth-fixture-a', 'oauth-fixture-b', 'oauth-fixture-c'])
  })

  it('keeps the legacy single token working, and de-duplicates it', async () => {
    const { oauthTokens } = await import('../src/draft')
    process.env.CLAUDE_CODE_OAUTH_TOKENS = 'oauth-fixture-a'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-fixture-a'
    expect(oauthTokens()).toEqual(['oauth-fixture-a'])

    delete process.env.CLAUDE_CODE_OAUTH_TOKENS
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-fixture-only'
    expect(oauthTokens()).toEqual(['oauth-fixture-only'])
  })

  it('drops blanks, so a trailing separator or an empty Secret key adds no attempt', async () => {
    const { oauthTokens } = await import('../src/draft')
    process.env.CLAUDE_CODE_OAUTH_TOKENS = 'oauth-fixture-a,,\n  \n'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = ''
    expect(oauthTokens()).toEqual(['oauth-fixture-a'])
  })

  it('recognises the quota failures that should rotate, and not the ones that should not', async () => {
    const { isQuotaError } = await import('../src/draft')
    expect(isQuotaError('claude exited 1: api_error_status 429: You\'ve hit your weekly limit · resets 4am (UTC)')).toBe(true)
    expect(isQuotaError('rate limit exceeded')).toBe(true)
    expect(isQuotaError('claude exited 1: no JSON object in model output')).toBe(false)
    expect(isQuotaError('spawn ENOENT')).toBe(false)
  })

  it('⚠ a token label is non-reversible, so it is safe to log', async () => {
    const { tokenLabel } = await import('../src/draft')
    const secret = 'oauth-fixture-MUST-NOT-LEAK-aaaaaaaaaaaa'
    const label = tokenLabel(secret, 0)
    expect(label).not.toContain('MUST-NOT-LEAK')
    expect(label).not.toContain(secret.slice(8))
    expect(label.startsWith('#1/')).toBe(true)
    // stable for the same token, different for another
    expect(tokenLabel(secret, 0)).toBe(label)
    expect(tokenLabel('oauth-fixture-other', 0)).not.toBe(label)
  })

  it('counts the pool on /health without revealing it', async () => {
    const { credentialStatus } = await import('../src/draft')
    process.env.CLAUDE_CODE_OAUTH_TOKENS = 'oauth-fixture-MUST-NOT-LEAK-1,oauth-fixture-MUST-NOT-LEAK-2,oauth-fixture-MUST-NOT-LEAK-3'
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    const s = credentialStatus()
    expect(s.subscriptions).toBe(3)
    expect(s.usable).toBe(true)
    expect(s.detail).toContain('3 subscription token(s)')
    expect(s.detail).not.toContain('MUST-NOT-LEAK')
  })
})
