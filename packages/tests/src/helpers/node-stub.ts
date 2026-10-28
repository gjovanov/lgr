import { randomBytes } from 'crypto'
import { makeDesktopStub, type DesktopStub } from './desktop-stub'

/**
 * A stand-in for a master's supervisor (FR-20.2): its own node id, as `front.rs` makes it, and an
 * Ed25519 key that signs exactly as the desktop stub does. One signer for both, so the two suites
 * cannot drift apart on how an assertion is made.
 */
export interface NodeStub extends DesktopStub {
  nodeId: string
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function makeNodeStub(overrides: { nodeId?: string; installationId?: string } = {}): NodeStub {
  const stub = makeDesktopStub(overrides.installationId ? { installationId: overrides.installationId } : {})
  const nodeId = overrides.nodeId ?? `master-${Array.from(randomBytes(16), b => BASE32[b % 32]).join('')}`
  return Object.assign(stub, { nodeId })
}

/** The registration a stub sends: its id, its key, and a proof signed by that key for `audience`. */
export function nodeEnrollBody(stub: NodeStub, audience: string, extra: Record<string, unknown> = {}) {
  return {
    nodeId: stub.nodeId,
    installationId: stub.installationId,
    name: 'Kasa server',
    publicKey: stub.publicKey,
    proof: stub.assertion({ sub: stub.nodeId, audience }),
    linkLevel: 'control',
    os: { platform: 'windows', version: '11', arch: 'x86_64' },
    versions: { app: '2026.10.25', protocol: 1, schema: '0007', supto: '1.0' },
    ...extra,
  }
}
