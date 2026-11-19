import { createPublicKey } from 'node:crypto'
import buildKind from 'config/build-kind'

/**
 * FR-20 plan F.4.4: the keys a TEST build trusts beside its built-in ones, for the field lanes'
 * throwaway global (global-eph).
 *
 * A master verifies licences and "Sign in with LGR" assertions with the keys built into its package.
 * In production, global signs only with one of those keys. A lane's global signs with keys made for
 * that run, so the packages under test must trust keys nobody knew when they were built.
 *
 * - **A test build** is one made from a tree whose `config/src/build-kind.json` says
 *   `"testKeys": true`. Every build embeds that file: this bundle, the supervisor
 *   (`packages/server/src/build_kind.rs`) and the image. Such a build also trusts the keys named in
 *   `LGR_TEST_LICENCE_KEYS` and `LGR_TEST_IDP_KEYS`. On a master they come from `config/api.env`,
 *   which the supervisor reads too. Each is a comma-separated list of base64 Ed25519
 *   SubjectPublicKeyInfo DER.
 * - **Any other build** ignores both variables, whoever sets them.
 *
 * ⚠ The committed file says false, and `unit/licence.test.ts` keeps it so. Every release path
 * refuses a test build: `scripts/check-package.ts`, the server release workflow and
 * `scripts/deploy-prod.sh`.
 *
 * Import-pure: `node:crypto` only.
 */
export const TEST_KEYS_BUILD: boolean = (buildKind as { testKeys?: unknown }).testKeys === true

export const TEST_LICENCE_KEYS_ENV = 'LGR_TEST_LICENCE_KEYS'
export const TEST_IDP_KEYS_ENV = 'LGR_TEST_IDP_KEYS'

/**
 * The public keys (base64 SPKI DER) that a test build trusts beside its built-in ones: `raw` split on
 * commas, with each entry checked to be an Ed25519 key. In any other build, none.
 *
 * Throws on an entry that is not such a key, so a lane that names a wrong key fails at start rather
 * than at its first sign-in.
 */
export function testTrustKeys(raw: string | undefined, testBuild: boolean = TEST_KEYS_BUILD): string[] {
  if (!testBuild || !raw?.trim()) return []
  return raw.split(',').map(s => s.trim()).filter(Boolean).map((b64, i) => {
    let type: string | undefined
    try {
      type = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType
    } catch {
      type = undefined
    }
    if (type !== 'ed25519') throw new Error(`test trust key ${i + 1} is not a base64 Ed25519 public key (SPKI DER)`)
    return b64
  })
}
