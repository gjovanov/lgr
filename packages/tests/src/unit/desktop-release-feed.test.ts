import { describe, it, expect, afterEach } from 'bun:test'
import { config } from 'config'
import { configuredRelease } from '../../../portal-api/src/controllers/desktop-v1.controller.js'

/**
 * #93 — the update offer a hub makes from its own configuration.
 *
 * The bug this closes was silence. `releaseFeedUrl` was the ONLY source of a release manifest, it
 * has never been set in any deployment, and nothing publishes a `<channel>.json` anywhere — so
 * `/api/desktop/v1/latest-release` always answered `release: null`, which the shell reads as
 * "nothing on offer" and reports to the operator as **up to date**. A till ran a seven-month-old
 * build and said it was current.
 *
 * ⚠ These tests mutate `config.desktop` directly. `config` is built eagerly at import, so setting
 * `process.env` here would be too late — and the alternative, re-importing the module per case,
 * would test a different object than the controller holds.
 */

const d = config.desktop as {
  releaseVersion: string
  releaseUrl: string
  releaseNotes: string
  releaseFeedUrl: string
  releaseGithubToken: string
}

const original = {
  releaseVersion: d.releaseVersion,
  releaseUrl: d.releaseUrl,
  releaseNotes: d.releaseNotes,
  releaseGithubToken: d.releaseGithubToken,
}

afterEach(() => {
  d.releaseVersion = original.releaseVersion
  d.releaseUrl = original.releaseUrl
  d.releaseNotes = original.releaseNotes
  d.releaseGithubToken = original.releaseGithubToken
})

describe('the release a hub offers from its configuration', () => {
  it('offers nothing when no version is set, which is the default', () => {
    d.releaseVersion = ''
    // ⚠ The safe direction, and today's behaviour. "No update source configured" and "you are up
    // to date" are different answers; the endpoint keeps answering the first as `null`.
    expect(configuredRelease('stable')).toBeNull()
  })

  it('offers the configured version on the stable channel', () => {
    d.releaseVersion = '0.1.4'
    expect(configuredRelease('stable')).toEqual({ version: '0.1.4' })
  })

  it('carries the download URL and notes when they are set, and omits them when not', () => {
    d.releaseVersion = '0.2.0'
    d.releaseUrl = 'https://github.com/gjovanov/lgr/releases/tag/desktop-v0.2.0'
    d.releaseNotes = 'Fiscal bridge reconnects by itself.'
    expect(configuredRelease('stable')).toEqual({
      version: '0.2.0',
      url: 'https://github.com/gjovanov/lgr/releases/tag/desktop-v0.2.0',
      notes: 'Fiscal bridge reconnects by itself.',
    })

    d.releaseUrl = ''
    d.releaseNotes = ''
    const bare = configuredRelease('stable') as Record<string, unknown>
    expect(Object.keys(bare).sort()).toEqual(['version'])
  })

  /**
   * The releases are in a PRIVATE repository, so a GitHub link 404s for every till operator.
   * With no URL configured, the offer links this server's own download page — but only when the
   * server can actually serve it, or the till would be handed a dead link.
   */
  it('links this server\'s download page when no URL is set and downloads are configured', () => {
    d.releaseVersion = '0.1.5'
    d.releaseUrl = ''
    d.releaseGithubToken = ''
    expect(configuredRelease('stable')).toEqual({ version: '0.1.5' })

    d.releaseGithubToken = 'test-token'
    const base = config.email.appUrl.replace(/\/$/, '')
    expect(configuredRelease('stable')).toEqual({ version: '0.1.5', url: `${base}/api/desktop/download/0.1.5` })

    d.releaseUrl = 'https://downloads.example/lgr'
    expect(configuredRelease('stable')).toEqual({ version: '0.1.5', url: 'https://downloads.example/lgr' })
  })

  it('refuses a version it cannot parse rather than offering it', () => {
    /**
     * ⚠ This is the case worth having. The value is typed by a human into a configmap at
     * promotion time, and the shell's `is_upgrade` refuses a version it cannot read — so a typo
     * would be silently inert on every till, with nothing anywhere saying why. Refusing here puts
     * the failure next to the configuration change that caused it.
     */
    for (const bad of ['v0.1.4-oops!', 'latest', '0.1', '', '  ', 'десет']) {
      d.releaseVersion = bad
      expect(configuredRelease('stable'), `offered a bad version: ${JSON.stringify(bad)}`).toBeNull()
    }
  })

  it('serves only the stable channel, and does not pass stable off as another', () => {
    // ⚠ A beta fleet needs a real feed. Answering `null` is honest; answering the stable build
    // would silently put every beta till back on stable.
    d.releaseVersion = '0.1.4'
    expect(configuredRelease('beta')).toBeNull()
    expect(configuredRelease('nightly')).toBeNull()
    expect(configuredRelease('stable')).not.toBeNull()
  })

  it('accepts a prerelease version, since that is what a beta feed would carry', () => {
    d.releaseVersion = '0.2.0-rc.1'
    expect(configuredRelease('stable')).toEqual({ version: '0.2.0-rc.1' })
  })
})
