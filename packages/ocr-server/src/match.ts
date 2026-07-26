/**
 * Map supplier-invoice line descriptions onto a SMALL candidate set of our catalog
 * products (the lines of one Order supplier group). Suppliers name fasteners in
 * their own convention (DIN vs ISO designations, German/English abbreviations,
 * size/material variants) — exact matching fails there, but a constrained pick
 * from ~10-50 known candidates is reliable AI territory.
 *
 * Same engine strategy as draft.ts: headless Claude Code (Max OAuth) first,
 * Anthropic API fallback. Default model haiku — the candidate set keeps it easy.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = join(HERE, '..')

const MATCH_MODEL = process.env.OCR_MATCH_MODEL || process.env.OCR_DRAFT_MODEL || 'claude-haiku-4-5'

export interface MatchCandidate {
  id: string
  name: string
  sku?: string
}

export interface MatchResult {
  matches: (string | null)[]
  model: string
  engine: 'claude-code' | 'api'
}

function buildPrompt(lines: string[], candidates: MatchCandidate[]): string {
  return [
    'You match supplier-invoice line descriptions to products from OUR catalog.',
    'The supplier uses its own naming: DIN vs ISO fastener designations (e.g. DIN 963 ≡ ISO 2009, DIN 965 ≡ ISO 7046, DIN 933 ≡ ISO 4017, DIN 934 ≡ ISO 4032, DIN 125 ≡ ISO 7089), German/English/Bulgarian wording, abbreviations, and size formats like "M4x70" / "М4Х70" / "4Х70".',
    '',
    'Rules:',
    '- Match on the technical essence: standard (DIN/ISO equivalence allowed), thread/diameter × length, material/class (A2, A4, 8.8, zinc).',
    '- Dimensions and material MUST match exactly — "M4x70" never matches "M4x60".',
    '- Each candidate may be used for multiple lines if genuinely the same product.',
    '- If unsure, or no candidate fits: null. NEVER guess.',
    '',
    'Candidates (JSON array of our products):',
    JSON.stringify(candidates.map((c) => ({ id: c.id, name: c.name, sku: c.sku || undefined }))),
    '',
    'Supplier lines (JSON array of strings):',
    JSON.stringify(lines),
    '',
    `Return ONLY a JSON array with exactly ${lines.length} elements — for each supplier line, the matching candidate "id" string or null.`,
  ].join('\n')
}

function parseMatches(text: string, expected: number): (string | null)[] {
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) throw new Error('no JSON array in model output')
  const arr = JSON.parse(m[0])
  if (!Array.isArray(arr)) throw new Error('model output is not an array')
  const out: (string | null)[] = []
  for (let i = 0; i < expected; i++) {
    const v = arr[i]
    out.push(typeof v === 'string' && v.trim() ? v.trim() : null)
  }
  return out
}

function claudeConfigured(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true
  try {
    return existsSync(join(homedir(), '.claude', '.credentials.json'))
  } catch {
    return false
  }
}

async function viaClaudeCode(prompt: string, model: string): Promise<string> {
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
  try {
    const wrapper = JSON.parse(out)
    return typeof wrapper?.result === 'string' ? wrapper.result : out
  } catch {
    return out
  }
}

async function viaApi(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (Claude Code failed and no API fallback)')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })
  const resp = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })
  return resp.content[0]?.type === 'text' ? resp.content[0].text : ''
}

export async function matchLines(lines: string[], candidates: MatchCandidate[]): Promise<MatchResult> {
  if (!lines.length || !candidates.length) {
    return { matches: lines.map(() => null), model: MATCH_MODEL, engine: 'api' }
  }
  const prompt = buildPrompt(lines, candidates)
  const validIds = new Set(candidates.map((c) => c.id))

  let raw: string
  let engine: MatchResult['engine']
  if (claudeConfigured()) {
    try {
      raw = await viaClaudeCode(prompt, MATCH_MODEL)
      engine = 'claude-code'
    } catch (err) {
      if (!process.env.ANTHROPIC_API_KEY) throw err
      raw = await viaApi(prompt, MATCH_MODEL)
      engine = 'api'
    }
  } else {
    raw = await viaApi(prompt, MATCH_MODEL)
    engine = 'api'
  }

  const parsed = parseMatches(raw, lines.length)
  // Discard hallucinated ids — only candidate ids count.
  const matches = parsed.map((id) => (id && validIds.has(id) ? id : null))
  return { matches, model: MATCH_MODEL, engine }
}
