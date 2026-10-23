/**
 * Map extracted invoice text → structured InvoiceExtraction via Claude.
 * Primary engine: headless Claude Code (`claude -p`) authenticated with a Max
 * subscription OAuth token (CLAUDE_CODE_OAUTH_TOKEN). Fallback: Anthropic API
 * (@anthropic-ai/sdk, ANTHROPIC_API_KEY). Default model claude-haiku-4-5;
 * escalate to claude-sonnet-4-5 when deterministic validation fails.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { DraftResult, InvoiceExtraction, Profile } from './schema.js'
import { validateExtraction } from './validate.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(HERE, '..', '.claude', 'skills')
const PROJECT_DIR = join(HERE, '..') // dir whose .claude/skills Claude Code can see

/** One instruction set per document family. */
const SKILL_BY_PROFILE: Record<Profile, string> = {
  invoice: 'draft-purchase-invoice',
  goods_receipt: 'draft-goods-receipt',
  stock_note: 'draft-stock-note',
}

/**
 * Which profile a document needs, from its printed header. Checked most-specific first:
 * the correction variant of a стокова разписка before the plain one, and ФАКТУРА last
 * because delivery notes routinely quote an invoice number in their body.
 */
export function detectProfile(text: string): Profile {
  const t = text || ''
  if (/2000\s+КОРЕКЦИЯ/i.test(t)) return 'goods_receipt'
  if (/За\s+отпускане\s+на\s+материали/i.test(t)) return 'stock_note'
  if (/СКЛАДОВА\s+РАЗПИСКА/i.test(t)) return 'stock_note'
  if (/СТОКОВА\s+РАЗПИСКА/i.test(t)) return 'goods_receipt'
  return 'invoice'
}

const DEFAULT_MODEL = process.env.OCR_DRAFT_MODEL || 'claude-haiku-4-5'
const ESCALATION_MODEL = process.env.OCR_DRAFT_ESCALATION_MODEL || 'claude-sonnet-4-5'

/** Skill bodies (frontmatter stripped) — the single source of extraction instructions. */
const skillCache = new Map<Profile, string>()
function instructions(profile: Profile): string {
  let body = skillCache.get(profile)
  if (body == null) {
    const raw = readFileSync(join(SKILLS_DIR, SKILL_BY_PROFILE[profile], 'SKILL.md'), 'utf-8')
    body = raw.replace(/^---[\s\S]*?---\s*/, '').trim()
    skillCache.set(profile, body)
  }
  return body
}

function parseInvoiceJson(text: string): InvoiceExtraction {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('no JSON object in model output')
  const obj = JSON.parse(m[0])
  obj.supplier ??= {}
  obj.customer ??= {}
  obj.line_items ??= []
  return obj as InvoiceExtraction
}

/**
 * The failure the CLI reported inside its own `--output-format json` envelope, or null when it
 * reported none. Exported so the interpretation can be tested without spawning anything.
 */
export function claudeEnvelopeError(wrapper: any): string | null {
  if (!wrapper?.is_error) return null
  const status = wrapper.api_error_status ? `api_error_status ${wrapper.api_error_status}: ` : ''
  return `${status}${String(wrapper.result || wrapper.terminal_reason || 'unspecified error')}`
}

/** Parse without throwing — the CLI's envelope is JSON on success AND on failure, but not always. */
function safeJson(s: string): any | null {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

async function draftViaClaudeCode(text: string, model: string, profile: Profile): Promise<InvoiceExtraction> {
  const prompt = `${instructions(profile)}\n\nDocument text:\n\n${text}\n\nReturn only the JSON object.`
  // Headless single-turn extraction (no tools needed — the skill body is embedded in
  // the prompt). --output-format json wraps the assistant text in { result: "..." }.
  // Use ASYNC Bun.spawn (not spawnSync): a sync spawn blocks the event loop for the
  // whole claude call (~30s), so the server can't answer health probes during a batch
  // and k8s kills the pod. Async keeps /health responsive.
  const proc = Bun.spawn(
    ['claude', '-p', prompt, '--model', model, '--output-format', 'json', '--max-turns', '1', '--dangerously-skip-permissions'],
    { cwd: PROJECT_DIR, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const out = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  const wrapper = safeJson(out)

  /**
   * ⚠ The CLI writes its diagnosis to STDOUT, not stderr.
   *
   * On a failure it still prints its `--output-format json` envelope, carrying `is_error`,
   * `api_error_status` and a human `result` — then exits non-zero with stderr EMPTY. Reporting
   * only the exit code therefore threw away the one thing worth knowing: for eight days
   * (2026-10-15 … 23) regal's imports failed as `claude exited 1: no stderr`, while that envelope
   * had been saying `api_error_status: 429 — "You've hit your weekly limit · resets 4am (UTC)"`
   * all along. A 429 on the subscription needs an ANTHROPIC_API_KEY fallback or a wait; nothing
   * about the documents was wrong.
   */
  const envelopeError = claudeEnvelopeError(wrapper)
  if (exitCode !== 0 || envelopeError) {
    const err = (await new Response(proc.stderr).text()).trim()
    const reason = envelopeError || err.slice(0, 300) || 'no stderr and no error envelope'
    throw new Error(`claude exited ${exitCode}: ${reason}`)
  }

  const resultText = typeof wrapper?.result === 'string' ? wrapper.result : out
  return parseInvoiceJson(resultText)
}

async function draftViaApi(text: string, model: string, profile: Profile): Promise<InvoiceExtraction> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (Claude Code failed and no API fallback)')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })
  const resp = await client.messages.create({
    model,
    max_tokens: 8192,
    system: instructions(profile),
    messages: [{ role: 'user', content: `Document text:\n\n${text}\n\nReturn only the JSON object.` }],
  })
  const out = resp.content[0]?.type === 'text' ? resp.content[0].text : ''
  return parseInvoiceJson(out)
}

/** Claude Code is usable if a Max OAuth token is set or a credentials file is present. */
function claudeConfigured(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true
  try {
    return existsSync(join(homedir(), '.claude', '.credentials.json'))
  } catch {
    return false
  }
}

/**
 * Which credentials this process actually has. ⚠ An env var set from a Secret key that is absent
 * or empty arrives as `''`, which is falsy but says nothing in a log — so report the distinction
 * rather than letting it surface as `claude exited 1: no stderr`.
 *
 * That exact shape cost regal eight days of unreadable documents (2026-10-15 … 23): the sidecar's
 * `ocr-secret` held an EMPTY `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` was `optional: true`
 * and absent, so `claude` ran unauthenticated, exited 1, and there was no fallback to explain it.
 */
export function credentialStatus(): { usable: boolean; oauth: boolean; credentialsFile: boolean; apiKey: boolean; detail: string } {
  const oauth = !!process.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = !!process.env.ANTHROPIC_API_KEY
  let credentialsFile = false
  try {
    credentialsFile = existsSync(join(homedir(), '.claude', '.credentials.json'))
  } catch { /* unreadable home — treat as absent */ }
  const usable = oauth || credentialsFile || apiKey
  const detail = usable
    ? `credentials: ${[oauth && 'CLAUDE_CODE_OAUTH_TOKEN', credentialsFile && '~/.claude/.credentials.json', apiKey && 'ANTHROPIC_API_KEY'].filter(Boolean).join(' + ')}`
    : 'no usable credential: CLAUDE_CODE_OAUTH_TOKEN is unset or EMPTY, ~/.claude/.credentials.json is absent, '
      + 'and ANTHROPIC_API_KEY is unset or EMPTY. Every /draft will fail until one of them is set '
      + '(an env var sourced from a missing or empty Secret key arrives as an empty string).'
  return { usable, oauth, credentialsFile, apiKey, detail }
}

async function runEngine(text: string, model: string, profile: Profile): Promise<{ extraction: InvoiceExtraction; engine: DraftResult['engine'] }> {
  // Say what is missing BEFORE spawning an unauthenticated `claude`, which exits 1 with no stderr
  // and makes a configuration problem look like a model problem.
  const cred = credentialStatus()
  if (!cred.usable) throw new Error(cred.detail)

  // Prefer Claude Code (Max) when configured; otherwise go straight to the API.
  if (claudeConfigured()) {
    try {
      return { extraction: await draftViaClaudeCode(text, model, profile), engine: 'claude-code' }
    } catch (err: any) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error(`${String(err?.message || err)} — and ANTHROPIC_API_KEY is unset or empty, so there is no API fallback`)
      }
      // fall through to API
    }
  }
  return { extraction: await draftViaApi(text, model, profile), engine: 'api' }
}

export async function draftInvoice(text: string, requestedProfile?: Profile): Promise<DraftResult> {
  const profile = requestedProfile ?? detectProfile(text)
  let model = DEFAULT_MODEL
  let { extraction, engine } = await runEngine(text, model, profile)
  let validation = validateExtraction(extraction, profile)

  // Escalate once to a stronger model only on STRUCTURAL failures (Σlines≠net or
  // net+vat≠gross) — these suggest the model missed/misread lines. Per-line
  // arithmetic fails usually reflect the supplier's own rounding, which a stronger
  // model won't "fix"; those still surface as needs_review for the user.
  const structuralFail = (v: typeof validation) =>
    v.checks.some(c => c.status === 'fail' && (c.check === 'lines_sum_net' || c.check === 'totals_net_vat_gross'))
  if (structuralFail(validation) && ESCALATION_MODEL && ESCALATION_MODEL !== model) {
    try {
      model = ESCALATION_MODEL
      const retry = await runEngine(text, model, profile)
      const retryValidation = validateExtraction(retry.extraction, profile)
      if (retryValidation.checks.filter(c => c.status === 'fail').length <= validation.checks.filter(c => c.status === 'fail').length) {
        extraction = retry.extraction
        engine = retry.engine
        validation = retryValidation
      }
    } catch {
      /* keep the first result */
    }
  }

  return { extraction, validation, model, engine, profile }
}
