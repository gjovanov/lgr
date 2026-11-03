import { describe, it, expect } from 'bun:test'
import {
  aadFor, blindIndex, CANARY, generateKey, generateKeyId, isSealed, kekIdOf, keyIdOf, maskIdentifier,
  open, parseKek, seal, unwrapKey, wrapKey,
} from 'services/biz/personal-data/crypto'

/**
 * FR-25 §3.12. Made-up values only: the ЕГН below passes the checksum, and month 13 means it can be nobody's.
 */
const FAKE_EGN = '7513020014'

function refusal(fn: () => unknown): string | null {
  try { fn(); return null } catch (e: any) { return String(e?.message ?? e) }
}

describe('sealing a value', () => {
  const key = generateKey()
  const keyId = generateKeyId()
  const aad = aadFor(keyId, 'Employee', 'doc-1', 'personal')

  it('round-trips, and the stored form holds nothing of the value', () => {
    const sealed = seal(key, keyId, FAKE_EGN, aad)
    expect(isSealed(sealed)).toBe(true)
    expect(keyIdOf(sealed)).toBe(keyId)
    expect(sealed).not.toContain(FAKE_EGN)
    expect(open(key, sealed, aad)).toBe(FAKE_EGN)
  })

  it('never produces the same ciphertext twice', () => {
    expect(seal(key, keyId, FAKE_EGN, aad)).not.toBe(seal(key, keyId, FAKE_EGN, aad))
  })

  it('does not open for another document, the IBAN-copying attack', () => {
    const sealed = seal(key, keyId, 'an iban', aad)
    const onAnotherPerson = aadFor(keyId, 'Employee', 'doc-2', 'personal')
    expect(refusal(() => open(key, sealed, onAnotherPerson))).not.toBeNull()
  })

  it('does not open for another field or model', () => {
    const sealed = seal(key, keyId, 'x', aad)
    expect(refusal(() => open(key, sealed, aadFor(keyId, 'Employee', 'doc-1', 'other')))).not.toBeNull()
    expect(refusal(() => open(key, sealed, aadFor(keyId, 'Payslip', 'doc-1', 'personal')))).not.toBeNull()
  })

  it('does not open with another key', () => {
    const sealed = seal(key, keyId, 'x', aad)
    expect(refusal(() => open(generateKey(), sealed, aad))).not.toBeNull()
  })

  it('notices a flipped byte', () => {
    const sealed = seal(key, keyId, 'x', aad)
    const parts = sealed.split('.')
    const body = Buffer.from(parts[3], 'base64url')
    body[0] ^= 1
    parts[3] = body.toString('base64url')
    expect(refusal(() => open(key, parts.join('.'), aad))).not.toBeNull()
  })

  it('says a plain value is not sealed, however it looks', () => {
    for (const v of [FAKE_EGN, '', null, undefined, 12, 'pd1', 'pd2.a.b.c']) expect(isSealed(v)).toBe(false)
    expect(refusal(() => open(key, FAKE_EGN, aad))).not.toBeNull()
  })
})

describe('wrapping a key', () => {
  it('round-trips under the KEK', () => {
    const kek = generateKey()
    const dek = generateKey()
    const wrapped = wrapKey(kek, 'k1', 'dek', dek)
    expect(unwrapKey(kek, wrapped, 'dek').equals(dek)).toBe(true)
  })

  it('does not open under another KEK, or as the other kind of key', () => {
    const kek = generateKey()
    const wrapped = wrapKey(kek, 'k1', 'dek', generateKey())
    expect(refusal(() => unwrapKey(generateKey(), wrapped, 'dek'))).not.toBeNull()
    expect(refusal(() => unwrapKey(kek, wrapped, 'index'))).not.toBeNull()
  })

  it('names a KEK without showing it', () => {
    const kek = generateKey()
    expect(kekIdOf(kek)).toHaveLength(12)
    expect(kek.toString('hex')).not.toContain(kekIdOf(kek))
    expect(kekIdOf(kek)).not.toBe(kekIdOf(generateKey()))
  })

  it('takes a KEK only as 32 bytes of base64', () => {
    const good = generateKey().toString('base64')
    expect(parseKek(good)).toHaveLength(32)
    expect(refusal(() => parseKek('too short'))).not.toBeNull()
    expect(refusal(() => parseKek(Buffer.alloc(16).toString('base64')))).not.toBeNull()
  })
})

describe('looking up a sealed value', () => {
  const indexKey = generateKey()

  it('is equal for the same value however it was typed, and keyed', () => {
    expect(blindIndex(indexKey, 'nationalId', FAKE_EGN)).toBe(blindIndex(indexKey, 'nationalId', ` ${FAKE_EGN} `))
    expect(blindIndex(indexKey, 'nationalId', FAKE_EGN)).not.toBe(blindIndex(generateKey(), 'nationalId', FAKE_EGN))
    expect(blindIndex(indexKey, 'nationalId', FAKE_EGN)).not.toContain(FAKE_EGN)
  })

  it('differs between fields, so one column cannot be matched against another', () => {
    expect(blindIndex(indexKey, 'nationalId', FAKE_EGN)).not.toBe(blindIndex(indexKey, 'taxId', FAKE_EGN))
  })
})

describe('masking an identifier', () => {
  it('shows the last four and no more', () => {
    expect(maskIdentifier(FAKE_EGN)).toBe('••••••0014')
    expect(maskIdentifier('123')).toBe('•••')
    expect(maskIdentifier('BG80 BNBG 9661 1020 3456 78')).toEndWith('5678')
  })
})

it('the canary is a constant, so any key can be proven against it', () => {
  expect(CANARY.length).toBeGreaterThan(8)
})
