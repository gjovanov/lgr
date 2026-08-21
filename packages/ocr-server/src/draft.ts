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
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`claude exited ${exitCode}: ${err.slice(0, 300) || 'no stderr'}`)
  }
  let resultText = out
  try {
    const wrapper = JSON.parse(out)
    resultText = typeof wrapper?.result === 'string' ? wrapper.result : out
  } catch {
    /* not wrapped — use raw */
  }
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

async function runEngine(text: string, model: string, profile: Profile): Promise<{ extraction: InvoiceExtraction; engine: DraftResult['engine'] }> {
  // Prefer Claude Code (Max) when configured; otherwise go straight to the API.
  if (claudeConfigured()) {
    try {
      return { extraction: await draftViaClaudeCode(text, model, profile), engine: 'claude-code' }
    } catch (err: any) {
      if (!process.env.ANTHROPIC_API_KEY) throw err
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
