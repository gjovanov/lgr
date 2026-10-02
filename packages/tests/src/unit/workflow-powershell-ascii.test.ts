import { describe, it, expect } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Inline PowerShell in a workflow must be pure ASCII.
 *
 * ⚠ **This bug has bitten twice.** An em dash is three UTF-8 bytes — `E2 80 94` — which decode as
 * `â`, `€` and `”` when a `.ps1` is read as ANSI. That last character is U+201D RIGHT DOUBLE
 * QUOTATION MARK, and PowerShell treats it as **closing a string**: every token after it is a
 * parse error, and the reported error points at an innocent word far from the cause.
 *
 *   1. `desktop-ci.yml`'s "Collect the app log" step died with
 *      `Unexpected token 'it' in expression or statement` — the word after an em dash inside a
 *      double-quoted string. The step only runs on failure, so it sat there until the job it
 *      guards failed for an unrelated reason and then failed to collect the evidence.
 *   2. `lgr-deploy/vmtest/guest/win11/driver.ps1` would not parse AT ALL under Windows PowerShell
 *      5.1 for the same reason (fixed there by writing the file with a BOM, which a workflow's
 *      inline script cannot have — the runner writes the temp file, not us).
 *
 * ⚠ So the rule is narrow on purpose: **only inline `run:` blocks whose shell is PowerShell.**
 * Bash blocks are fine (every runner reads them as UTF-8), and YAML comments OUTSIDE the script
 * are fine because nothing parses them as PowerShell — which is where prose with dashes and ⚠
 * markers belongs, and where this repo keeps most of it.
 */

const WORKFLOWS = path.resolve(import.meta.dir, '../../../../.github/workflows')

interface Block { file: string; line: number; shell: string; text: string }

/**
 * Pull every inline `run: |` block out of a workflow, with the shell that will run it.
 *
 * ⚠ A hand-rolled scan rather than a YAML parse, deliberately: the line NUMBER is the whole point
 * of the failure message, and a parsed document has lost it.
 */
function inlineRunBlocks(file: string): Block[] {
  const lines = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8').split(/\r?\n/)
  const blocks: Block[] = []
  let shell = ''
  let defaultShell = ''
  let inRun = false
  let indent = 0
  let current = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // A `defaults.run.shell` at the top of the file applies to every step that sets none.
    const def = line.match(/^\s{4,}shell:\s*(\S+)\s*$/)
    if (def && !inRun && /^\s{4}shell:/.test(line)) defaultShell = def[1]

    const stepShell = line.match(/^\s*shell:\s*(\S+)\s*$/)
    if (stepShell && !inRun) shell = stepShell[1]

    const run = line.match(/^(\s*)run:\s*\|\s*$/)
    if (run && !inRun) {
      inRun = true
      indent = run[1].length
      current = shell || defaultShell || 'bash'
      shell = ''
      continue
    }

    if (inRun) {
      // The block ends at the first non-blank line indented no further than `run:` itself.
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) {
        inRun = false
      } else if (line.trim() !== '') {
        blocks.push({ file, line: i + 1, shell: current, text: line })
      }
    }
  }
  return blocks
}

const isPowerShell = (shell: string) => /^(pwsh|powershell)/i.test(shell)

describe('inline PowerShell in a workflow is ASCII-only', () => {
  const files = fs.readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))

  it('finds the workflows at all', () => {
    // ⚠ A guard on the guard. If the path is ever wrong, every assertion below passes over an
    // empty list and the check silently stops checking — which is how a test stays green for a
    // year without testing anything.
    expect(files.length).toBeGreaterThan(0)
  })

  it('has PowerShell steps to check', () => {
    const ps = files.flatMap(inlineRunBlocks).filter(b => isPowerShell(b.shell))
    expect(ps.length, 'the repo should still have inline PowerShell steps; if not, delete this test')
      .toBeGreaterThan(0)
  })

  it('no inline PowerShell line carries a non-ASCII character', () => {
    const offenders = files
      .flatMap(inlineRunBlocks)
      .filter(b => isPowerShell(b.shell))
      .filter(b => [...b.text].some(c => c.codePointAt(0)! > 127))
      .map(b => {
        const chars = [...new Set([...b.text].filter(c => c.codePointAt(0)! > 127))].join('')
        return `${b.file}:${b.line} [${b.shell}] contains ${JSON.stringify(chars)} — ${b.text.trim()}`
      })

    expect(
      offenders,
      'An em dash decodes to a smart quote that CLOSES a PowerShell string. Put the prose in a ' +
      'YAML comment outside the script, or use ASCII punctuation inside it.',
    ).toEqual([])
  })
})
