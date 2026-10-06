import { describe, it, expect, afterEach } from 'bun:test'
import { assertTokenOrg } from '../../../../scripts/lib/token-org.js'

/**
 * The ops scripts (imports, stock moves, comparisons) take `LGR_TOKEN` or sign in with `--org`.
 * Since a browser tab can switch org, a copied token may name another org than `--org`, and the
 * script would have written there. `assertTokenOrg` refuses that mismatch.
 */

const realExit = process.exit
const realError = console.error
let exitedWith: number | undefined

function guarded(fn: () => void) {
  exitedWith = undefined
  process.exit = ((code?: number) => {
    exitedWith = code ?? 0
    throw new Error('exit')
  }) as typeof process.exit
  console.error = () => {}
  try {
    fn()
  } catch (err) {
    if ((err as Error).message !== 'exit') throw err
  }
  return exitedWith
}

afterEach(() => {
  process.exit = realExit
  console.error = realError
})

describe('assertTokenOrg', () => {
  it('lets a token for the org the script was told through', () => {
    expect(guarded(() => assertTokenOrg({ org: { slug: 'regal-pz' } }, 'regal-pz'))).toBeUndefined()
    expect(guarded(() => assertTokenOrg({ org: { slug: 'regal-pz' } }, 'Regal-PZ'))).toBeUndefined()
  })

  it("stops a script whose token names another org than --org", () => {
    expect(guarded(() => assertTokenOrg({ org: { slug: 'regal-sf' } }, 'regal-pz'))).toBe(2)
  })

  it('has nothing to compare without an --org or without an org on the session', () => {
    expect(guarded(() => assertTokenOrg({ org: { slug: 'regal-sf' } }, undefined))).toBeUndefined()
    expect(guarded(() => assertTokenOrg({ org: null }, 'regal-pz'))).toBeUndefined()
  })
})
