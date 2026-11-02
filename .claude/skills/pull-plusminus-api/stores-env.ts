// stores-env.ts — where the PlusMinus stores' own identifiers come from.
//
// Server addresses, Roomler agent ids, PC names, company strings, local day folders and credential file paths are NOT in this
// repo: it is public. They live in the gitignored `.secrets/plusminus-stores.env` (shell-sourceable `NAME=value` lines), which
// the skills read by NAME. A real environment variable of the same name wins over the file, so one run can override any value.
//
// File lookup: $PLUSMINUS_STORES_ENV, then `<repo>/.secrets/plusminus-stores.env`, then the main checkout's, for a worktree
// (which has no .secrets of its own).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

let loaded: string | null | undefined

function candidates(): string[] {
  const here = import.meta.dir // .claude/skills/<skill>
  const list = [process.env.PLUSMINUS_STORES_ENV, resolve(here, '../../../.secrets/plusminus-stores.env')]
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here, stdout: 'pipe', stderr: 'ignore' })
    const common = r.stdout.toString().trim()
    if (r.exitCode === 0 && common) list.push(resolve(dirname(common), '.secrets/plusminus-stores.env'))
  } catch { /* no git: the first two are all there is */ }
  return list.filter((p): p is string => !!p)
}

/** Reads the file once and fills `process.env` for every name that is not already set. Returns the path used, or null. */
export function loadStoresEnv(): string | null {
  if (loaded !== undefined) return loaded
  loaded = null
  for (const path of candidates()) {
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (!m) continue
      let value = m[2].trim()
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1)
      if (process.env[m[1]] === undefined) process.env[m[1]] = value
    }
    loaded = path
    break
  }
  return loaded
}

/** A value that must exist; the error names the variable and the file, never a value. */
export function need(name: string): string {
  loadStoresEnv()
  const v = process.env[name]
  if (!v) {
    throw new Error(
      `${name} is not set. The stores' identifiers live in the gitignored .secrets/plusminus-stores.env ` +
      `(or the file named by PLUSMINUS_STORES_ENV); this repo is public and never carries them. ` +
      `See .claude/skills/pull-plusminus-api/SKILL.md, "Store identifiers".`,
    )
  }
  return v
}

/** A value that may be absent. */
export function optional(name: string): string | undefined {
  loadStoresEnv()
  return process.env[name] || undefined
}
