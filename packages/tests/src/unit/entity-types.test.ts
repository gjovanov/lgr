import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * FR-32.15 (#797): an entity's type comes from its model. A field added to the model is a field the repository knows,
 * with no second edit. Type-level, so the check compiles a probe with `tsc` (the tests package is not in CI's
 * type-check program): the probe must compile, and a mistake planted in a copy of it must not.
 */
const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const TSC = require.resolve('typescript/lib/tsc.js', { paths: [ROOT] })

const PROBE = `
import type { Document } from 'mongoose'
import type { IInvoice as DbInvoice } from 'db/models'
import type { IInvoice } from 'dal/entities'
import type { EntityOf } from 'dal/entity-of'

// Every field of the model is a field of the entity: nothing restated, nothing missed.
type ModelFields = Exclude<keyof DbInvoice, keyof Document | '_id' | '__v'>
type Missing = Exclude<ModelFields, keyof IInvoice>
export const nothingMissing: [Missing] extends [never] ? true : false = true

// A field added to the model reaches the entity by itself, as a plain value.
interface GrownInvoice extends DbInvoice { addedLater: string; addedRef: import('mongoose').Types.ObjectId }
type Grown = EntityOf<GrownInvoice>
export const added: Grown['addedLater'] = 'yes'
export const ref: Grown['addedRef'] = 'an id, as a string'
export const id: IInvoice['id'] = 'the repository id'
export const contact: IInvoice['contactId'] = 'a string, not an ObjectId'
__PLANT__
`

function compile(plant: string): { code: number; out: string } {
  const dir = mkdtempSync(join(ROOT, 'packages', 'tests', '.entity-types-'))
  try {
    writeFileSync(join(dir, 'probe.ts'), PROBE.replace('__PLANT__', plant))
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      extends: '../../../tsconfig.server.json',
      compilerOptions: { noEmit: true },
      include: ['probe.ts'],
    }))
    const proc = Bun.spawnSync([process.execPath, TSC, '--noEmit', '--pretty', 'false', '-p', join(dir, 'tsconfig.json')], { cwd: ROOT })
    return { code: proc.exitCode ?? 1, out: proc.stdout.toString() + proc.stderr.toString() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('entity types come from the schemas (FR-32.15)', () => {
  it('the Invoice entity has every field of its model, and a field added to a model reaches its entity', () => {
    const r = compile('')
    expect(r.out).toBe('')
    expect(r.code).toBe(0)
  }, 120_000)

  it('the probe can fail: an id typed as an ObjectId is refused (a positive control)', () => {
    const r = compile(`export const wrong: IInvoice['contactId'] = 42`)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('TS2322')
  }, 120_000)
})
