import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

/**
 * #546: a script connects to the database without building indexes.
 *
 * Mongoose builds every compiled model's collections and indexes when it connects, and `connectDB` compiles every
 * model (its warmup imports the barrel). A script run against production from a checkout ahead of the release
 * therefore built that release's indexes there before it shipped, and the deployed app later met an index its own
 * definition no longer matched. `connectDB({ readOnly: true })` turns that off, as `{ autoIndex: false, autoCreate:
 * false }` does for `mongoose.connect`. A script that inserts also calls `requireUniqueIndexes`
 * (`scripts/lib/require-indexes.ts`): the app builds the unique indexes, the script refuses to write without them.
 */

const SCRIPTS = resolve(import.meta.dir, '../../../../scripts')

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (name.endsWith('.ts') || name.endsWith('.js')) yield path
  }
}

/** The text between a call's parentheses, from just after its `(`. */
function argumentsOf(text: string, from: number): string {
  let depth = 1
  let i = from
  for (; i < text.length && depth > 0; i++) {
    if ('([{'.includes(text[i])) depth++
    else if (')]}'.includes(text[i])) depth--
  }
  return text.slice(from, i - 1).replace(/\s+/g, ' ').trim()
}

/** Whether the match sits on a comment line (`//`, or a line of a block comment). */
function inComment(text: string, at: number): boolean {
  const line = text.slice(text.lastIndexOf('\n', at) + 1, at).trimStart()
  return line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')
}

describe('a script connecting to the database', () => {
  it('never builds indexes', () => {
    const offenders: string[] = []
    let calls = 0
    for (const file of sources(SCRIPTS)) {
      const rel = relative(SCRIPTS, file).replace(/\\/g, '/')
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bconnectDB\(/g)) {
        if (inComment(text, m.index!)) continue
        calls++
        const args = argumentsOf(text, m.index! + m[0].length)
        if (!/^\{ ?readOnly: true ?\}$/.test(args)) offenders.push(`${rel}: connectDB(${args})`)
      }
      for (const m of text.matchAll(/\bmongoose\.connect\(/g)) {
        if (inComment(text, m.index!)) continue
        calls++
        const args = argumentsOf(text, m.index! + m[0].length)
        if (!/autoIndex: false/.test(args) || !/autoCreate: false/.test(args)) offenders.push(`${rel}: mongoose.connect(${args})`)
      }
    }
    // The scan found the scripts: a wrong path would pass with nothing to check.
    expect(calls).toBeGreaterThan(30)
    expect(offenders).toEqual([])
  })
})
