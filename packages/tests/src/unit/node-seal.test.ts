import { describe, it, expect } from 'bun:test'
import { generateSealKey, isSealPublicKey, openSealed, sealPublicKeyOf, sealTo } from 'services/biz/crypto/node-seal'

/**
 * The seal lgrai.app puts on what only one master may read (FR-20.40, plan step P2-4c): a person's
 * local credential on its way through whatever proxy sits between them.
 */

describe('node seal', () => {
  const key = generateSealKey()
  const secret = '$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA'

  it('opens with its key and its context, and with nothing else', () => {
    const sealed = sealTo(key.publicKey, secret, 'ctx-a')
    expect(openSealed(key.privateKey, sealed, 'ctx-a')).toBe(secret)
    expect(openSealed(key.privateKey, sealed, 'ctx-b')).toBeNull()
    expect(openSealed(generateSealKey().privateKey, sealed, 'ctx-a')).toBeNull()
    const [v, e, iv, body] = sealed.split('.')
    const flipped = body.slice(0, 10) + (body[10] === 'A' ? 'B' : 'A') + body.slice(11)
    expect(openSealed(key.privateKey, [v, e, iv, flipped].join('.'), 'ctx-a')).toBeNull()
    for (const bad of [undefined, '', 'lgrseal1', `${sealed}.x`, sealed.replace('lgrseal1', 'lgrseal2')]) {
      expect(openSealed(key.privateKey, bad, 'ctx-a')).toBeNull()
    }
  })

  it('shows nothing of what it carries, and never the same twice', () => {
    const a = sealTo(key.publicKey, secret, 'ctx')
    const b = sealTo(key.publicKey, secret, 'ctx')
    expect(a).not.toBe(b)
    for (const s of [a, b]) {
      expect(s).not.toContain('argon2')
      expect(s).not.toContain(Buffer.from(secret).toString('base64url').slice(0, 12))
    }
  })

  it('takes only a key that could be one', () => {
    expect(isSealPublicKey(key.publicKey)).toBe(true)
    expect(sealPublicKeyOf(key.privateKey)).toBe(key.publicKey)
    for (const bad of [undefined, '', 'short', Buffer.alloc(32).toString('base64url'), `${key.publicKey}A`, key.publicKey.replace(/./, '+')]) {
      expect(isSealPublicKey(bad)).toBe(false)
    }
    expect(() => sealTo('not-a-key', secret, 'ctx')).toThrow()
    expect(sealPublicKeyOf('nope')).toBeNull()
  })
})
