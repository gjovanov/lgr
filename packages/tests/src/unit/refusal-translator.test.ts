import { describe, it, expect } from 'bun:test'
import { createHttpClient, setRefusalTranslator } from 'ui-shared/composables/useHttpClient'

/**
 * A write the server refuses for where the org lives is said in the reader's language, by the
 * translator the shell's banner (`ui-shell/HomeBanner.vue`) sets. One slot, and in the one SPA two
 * shells trade places in one document: the portal's and a module's. The new banner sets its
 * translator while it renders, and the old one's unmount runs after that. If that took out whatever
 * was in the slot, a till would read the server's English after one hop from the App Hub.
 */

/** What a 409 with this code reads as, through the real interceptor. */
async function refused(code: string): Promise<string> {
  const client = createHttpClient('/api')
  const adapter = (config: any) => Promise.reject(Object.assign(new Error('refused'), {
    config,
    response: { status: 409, data: { code, message: 'the server said' }, headers: {}, config },
  }))
  try {
    await client.post('/x', {}, { adapter })
    return 'answered'
  } catch (e: any) {
    return e.response.data.message
  }
}

describe('setRefusalTranslator', () => {
  it('says a refusal in the words of the translator set', async () => {
    const stop = setRefusalTranslator(() => 'преведено')
    expect(await refused('org_home_elsewhere')).toBe('преведено')
    stop()
    expect(await refused('org_home_elsewhere')).toBe('the server said')
  })

  it('leaves what it does not know as the server said it', async () => {
    const stop = setRefusalTranslator(() => null)
    expect(await refused('anything')).toBe('the server said')
    stop()
  })

  it('a shell going away takes back its own translator, never the next shell\'s', async () => {
    const stopOld = setRefusalTranslator(() => 'old shell')
    const stopNew = setRefusalTranslator(() => 'new shell') // the new banner renders first
    stopOld() // then the old one's unmount runs
    expect(await refused('org_home_elsewhere')).toBe('new shell')
    stopNew()
    expect(await refused('org_home_elsewhere')).toBe('the server said')
  })
})
