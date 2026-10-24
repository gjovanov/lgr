/**
 * FR-20.29 (plan step P1-6) — the six words a person compares when a pairing code is typed by hand.
 *
 * ⚠ The vector below is shared with the desktop shell's test (`packages/desktop/src-tauri`), which
 * reads the same word file: if either side changes how words are drawn, one of the two fails.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { FINGERPRINT_WORDS, fingerprintDigest, fingerprintWords } from 'services/biz/desktop/fingerprint-words'

/** sha256("LGR Server CA test vector"), its words worked out bit by bit, independently. */
const VECTOR = {
  fp: 'sha256:J4_WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k',
  words: ['chest', 'leaf', 'question', 'voice', 'credit', 'utility'],
}

describe('the word list', () => {
  test('is BIP-39 English, word for word: 2048 words, the published SHA-256', async () => {
    expect(FINGERPRINT_WORDS.length).toBe(2048)
    expect(new Set(FINGERPRINT_WORDS).size).toBe(2048)
    const file = await Bun.file(new URL('../../../services/src/biz/desktop/fingerprint-words.txt', import.meta.url)).text()
    // .gitattributes keeps it LF on every checkout, so the bytes are the published ones.
    expect(createHash('sha256').update(file).digest('hex')).toBe('2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda')
    expect([FINGERPRINT_WORDS[0], FINGERPRINT_WORDS[2047]]).toEqual(['abandon', 'zoo'])
  })
})

describe('fingerprintWords', () => {
  test('the shared vector', () => {
    expect(fingerprintWords(VECTOR.fp)).toEqual(VECTOR.words)
  })

  test('the first 66 bits only, eleven to a word', () => {
    const zero = 'sha256:' + Buffer.alloc(32).toString('base64url')
    const ones = 'sha256:' + Buffer.alloc(32, 0xff).toString('base64url')
    expect(fingerprintWords(zero)).toEqual(Array(6).fill('abandon'))
    expect(fingerprintWords(ones)).toEqual(Array(6).fill('zoo'))
    // Bit 66 onwards changes nothing; bit 65 (the last of the sixth word) changes the sixth word.
    const past = Buffer.alloc(32)
    past[8] = 0b0010_0000
    expect(fingerprintWords('sha256:' + past.toString('base64url'))).toEqual(Array(6).fill('abandon'))
    const last = Buffer.alloc(32)
    last[8] = 0b0100_0000
    expect(fingerprintWords('sha256:' + last.toString('base64url'))).toEqual([...Array(5).fill('abandon'), 'ability'])
  })

  test('anything that is not a fingerprint has no words', () => {
    const digest = createHash('sha256').update('x').digest()
    for (const bad of [
      '',
      digest.toString('base64url'), // no prefix
      'sha1:' + digest.toString('base64url'),
      'sha256:' + digest.toString('base64'), // standard base64 has + / =
      'sha256:' + digest.subarray(0, 31).toString('base64url'),
      'sha256:' + digest.toString('hex'),
    ]) {
      expect([bad, fingerprintWords(bad)]).toEqual([bad, null])
    }
    expect(fingerprintDigest(VECTOR.fp)?.length).toBe(32)
  })
})
