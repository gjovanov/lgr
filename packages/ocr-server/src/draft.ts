/**
 * Map extracted invoice text → structured InvoiceExtraction via Claude.
 * Primary engine: headless Claude Code (`claude -p`) authenticated with a Max
 * subscription OAuth token (CLAUDE_CODE_OAUTH_TOKEN). Fallback: Anthropic API
 * (@anthropic-ai/sdk, ANTHROPIC_API_KEY). Default model claude-haiku-4-5;
 * escalate to claude-sonnet-4-5 when deterministic validation fails.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { DraftResult, InvoiceExtraction } from './schema.js'
import { validateExtraction } from './validate.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_PATH = join(HERE, '..', '.claude', 'skills', 'draft-purchase-invoice', 'SKILL.md')
const PROJECT_DIR = join(HERE, '..') // dir whose .claude/skills Claude Code can see

const DEFAULT_MODEL = process.env.OCR_DRAFT_MODEL || 'claude-haiku-4-5'
const ESCALATION_MODEL = process.env.OCR_DRAFT_ESCALATION_MODEL || 'claude-sonnet-4-5'

/** Skill body (frontmatter stripped) — the single source of extraction instructions. */
let skillInstructions: string | null = null
function instructions(): string {
  if (skillInstructions == null) {
    const raw = readFileSync(SKILL_PATH, 'utf-8')
    skillInstructions = raw.replace(/^---[\s\S]*?---\s*/, '').trim()
  }
  return skillInstructions
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

function draftViaClaudeCode(text: string, model: string): InvoiceExtraction {
  const prompt = `${instructions()}\n\nInvoice text:\n\n${text}\n\nReturn only the JSON object.`
  // Headless single-turn extraction (no tools needed — the skill body is embedded in
  // the prompt). --output-format json wraps the assistant text in { result: "..." }.
  const out = execFileSync(
    'claude',
    ['-p', prompt, '--model', model, '--output-format', 'json', '--max-turns', '1', '--dangerously-skip-permissions'],
    { encoding: 'utf-8', cwd: PROJECT_DIR, maxBuffer: 1 << 26, env: process.env, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let resultText = out
  try {
    const wrapper = JSON.parse(out)
    resultText = typeof wrapper?.result === 'string' ? wrapper.result : out
  } catch {
    /* not wrapped — use raw */
  }
  return parseInvoiceJson(resultText)
}

async function draftViaApi(text: string, model: string): Promise<InvoiceExtraction> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (Claude Code failed and no API fallback)')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })
  const resp = await client.messages.create({
    model,
    max_tokens: 8192,
    system: instructions(),
    messages: [{ role: 'user', content: `Invoice text:\n\n${text}\n\nReturn only the JSON object.` }],
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

async function runEngine(text: string, model: string): Promise<{ extraction: InvoiceExtraction; engine: DraftResult['engine'] }> {
  // Prefer Claude Code (Max) when configured; otherwise go straight to the API.
  if (claudeConfigured()) {
    try {
      return { extraction: draftViaClaudeCode(text, model), engine: 'claude-code' }
    } catch (err: any) {
      if (!process.env.ANTHROPIC_API_KEY) throw err
      // fall through to API
    }
  }
  return { extraction: await draftViaApi(text, model), engine: 'api' }
}

export async function draftInvoice(text: string): Promise<DraftResult> {
  let model = DEFAULT_MODEL
  let { extraction, engine } = await runEngine(text, model)
  let validation = validateExtraction(extraction)

  // Escalate once to a stronger model only on STRUCTURAL failures (Σlines≠net or
  // net+vat≠gross) — these suggest the model missed/misread lines. Per-line
  // arithmetic fails usually reflect the supplier's own rounding, which a stronger
  // model won't "fix"; those still surface as needs_review for the user.
  const structuralFail = (v: typeof validation) =>
    v.checks.some(c => c.status === 'fail' && (c.check === 'lines_sum_net' || c.check === 'totals_net_vat_gross'))
  if (structuralFail(validation) && ESCALATION_MODEL && ESCALATION_MODEL !== model) {
    try {
      model = ESCALATION_MODEL
      const retry = await runEngine(text, model)
      const retryValidation = validateExtraction(retry.extraction)
      if (retryValidation.checks.filter(c => c.status === 'fail').length <= validation.checks.filter(c => c.status === 'fail').length) {
        extraction = retry.extraction
        engine = retry.engine
        validation = retryValidation
      }
    } catch {
      /* keep the first result */
    }
  }

  return { extraction, validation, model, engine }
}
