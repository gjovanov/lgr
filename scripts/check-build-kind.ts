#!/usr/bin/env bun
/**
 * Which kind of build these bytes are, read back from the bytes (FR-20 plan F.4.4).
 *
 * A TEST build trusts licence and identity keys named at run time (`LGR_TEST_LICENCE_KEYS`,
 * `LGR_TEST_IDP_KEYS`), for the field lanes' throwaway global alone. The server release workflow
 * makes one only on a dispatch that asks for it (`test_keys`), and never signs or publishes it. Its
 * jobs run this to prove that every part is the kind of build the run meant to make, and its `sign`
 * job runs it to refuse a test build whatever the run's inputs said. Each part says its kind:
 * - the API's package, in its manifest (`testKeys`, scripts/build-server.ts);
 * - the supervisor, which embeds packages/config/src/build-kind.json (packages/server/src/build_kind.rs),
 *   so its binary holds that file's `"testKeys": …` line verbatim.
 *
 *   bun scripts/check-build-kind.ts --want true|false [--package <dir>]... [--supervisor <binary>]...
 *
 * Exits 1 when a part is another kind or does not say which it is, and 2 on a usage error.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST } from './lib/server-package.ts'

/** What the API's package in `dir` says: true for a test build, false for any other, null when it does not say. */
export function packageTestKeys(dir: string): boolean | null {
  const file = join(dir, MANIFEST)
  if (!existsSync(file)) return null
  try {
    const kind = (JSON.parse(readFileSync(file, 'utf8')) as { testKeys?: unknown }).testKeys
    return typeof kind === 'boolean' ? kind : null
  } catch {
    return null
  }
}

const SAYS_TEST = Buffer.from('"testKeys": true')
const SAYS_RELEASE = Buffer.from('"testKeys": false')

/** What a supervisor binary embeds: its build-kind.json's line, exactly one of the two, or null. */
export function supervisorTestKeys(bytes: Uint8Array): boolean | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const test = b.includes(SAYS_TEST)
  return test === b.includes(SAYS_RELEASE) ? null : test
}

export interface KindFinding { path: string; detail: string }

const name = (testKeys: boolean) => (testKeys ? 'a TEST build' : 'a release build')

/** Every part that is not the kind `want` names (true: a test build), or does not say which it is. */
export function checkBuildKind(want: boolean, parts: { packages?: string[]; supervisors?: string[] }): KindFinding[] {
  const findings: KindFinding[] = []
  const judge = (path: string, got: boolean | null, says: string) => {
    if (got === null) findings.push({ path, detail: `does not say which kind of build it is (${says})` })
    else if (got !== want) findings.push({ path, detail: `is ${name(got)}, and this run makes ${name(want)}` })
  }
  for (const dir of parts.packages ?? []) judge(join(dir, MANIFEST), packageTestKeys(dir), 'its manifest names no boolean testKeys')
  for (const bin of parts.supervisors ?? []) {
    judge(bin, existsSync(bin) ? supervisorTestKeys(readFileSync(bin)) : null,
      existsSync(bin) ? 'it embeds neither or both of the build-kind lines' : 'there is no such file')
  }
  return findings
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const valuesOf = (flag: string) => args.flatMap((a, i) => (a === flag && i + 1 < args.length ? [args[i + 1]] : []))
  const want = valuesOf('--want')
  const packages = valuesOf('--package')
  const supervisors = valuesOf('--supervisor')
  if (want.length !== 1 || !['true', 'false'].includes(want[0]) || packages.length + supervisors.length === 0) {
    console.error('usage: bun scripts/check-build-kind.ts --want true|false [--package <dir>]... [--supervisor <binary>]...')
    process.exit(2)
  }
  const testKeys = want[0] === 'true'
  const findings = checkBuildKind(testKeys, { packages, supervisors })
  for (const f of findings) console.log(`::error title=Not ${name(testKeys)}::${f.path} ${f.detail}`)
  if (findings.length) process.exit(1)
  console.log(`${[...packages.map(p => join(p, MANIFEST)), ...supervisors].join(', ')}: ${name(testKeys)}${testKeys ? ', for the field lanes only' : ''}`)
}
