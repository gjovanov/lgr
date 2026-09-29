import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'crypto'

/**
 * A stand-in for the LGR Desktop shell: an Ed25519 keypair plus the ability to sign client
 * assertions exactly as the Rust side will (FR-14.20).
 *
 * ⚠ Shared on purpose. The enrollment, token and boundary suites all need a desktop identity, the
 * Desktops-page e2e (FR-14.23) needs one to make a row appear, and the field lanes need the same
 * shape again. Three private copies of "how do I sign an assertion" would drift, and the one that
 * drifted would be the one testing the security boundary.
 */
export interface DesktopStub {
  installationId: string
  machineId: string
  /** base64 SPKI DER — what `POST /desktop/v1/enroll` expects. */
  publicKey: string
  privateKey: KeyObject
  /** Sign a compact JWS client assertion for the token endpoint. */
  assertion(opts: { sub: string; audience: string; jti?: string; iat?: number; exp?: number }): string
}

export function makeDesktopStub(overrides: Partial<Pick<DesktopStub, 'installationId' | 'machineId'>> = {}): DesktopStub {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const stub: DesktopStub = {
    installationId: overrides.installationId ?? randomBytes(16).toString('hex'),
    machineId: overrides.machineId ?? randomBytes(32).toString('hex'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey,
    assertion({ sub, audience, jti, iat, exp }) {
      const now = Math.floor(Date.now() / 1000)
      const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
      const payload = b64u(
        JSON.stringify({
          sub,
          aud: audience,
          iat: iat ?? now,
          exp: exp ?? now + 60,
          jti: jti ?? randomBytes(12).toString('hex'),
        }),
      )
      const sig = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
      return `${header}.${payload}.${sig}`
    },
  }
  return stub
}

function b64u(s: string): string {
  return Buffer.from(s).toString('base64url')
}

/** The enroll body a stub sends, with room to override any field a test wants to break. */
export function enrollBody(stub: DesktopStub, extra: Record<string, unknown> = {}) {
  return {
    installationId: stub.installationId,
    machineId: stub.machineId,
    name: 'Till 1',
    os: { platform: 'windows', version: '11', arch: 'x86_64' },
    hostname: 'TILL-1',
    appVersion: '0.2.0',
    publicKey: stub.publicKey,
    ...extra,
  }
}
