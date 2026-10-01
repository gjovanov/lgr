import { describe, it, expect } from 'bun:test'
import {
  parseVersion,
  compareVersions,
  meetsMinimum,
  isUpgrade,
} from 'services/biz/desktop/version'

/**
 * FR-14.28 / FR-14.29 — the version rules the hub and the fleet have to agree on.
 *
 * ⚠ This file is the TypeScript half of a pair. `packages/desktop/src-tauri/src/update.rs`
 * carries the same cases in Rust, because the hub decides whether a desktop is below
 * `DESKTOP_MIN_VERSION` and the desktop decides whether a manifest is an upgrade. If the two
 * disagree, a fleet either updates in a loop or never updates at all — and neither symptom
 * points at a comparison function.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

describe('version parsing (FR-14.28)', () => {
  it('accepts the shapes a release actually tags', () => {
    for (const good of ['1.2.3', 'v1.2.3', '1.2.3-beta.1', '1.2.3+20260930', ' 1.2.3 ']) {
      expect({ good, parsed: parseVersion(good) !== null }).toEqual({ good, parsed: true })
    }
  })

  it('refuses rather than coerces anything else', () => {
    // ⚠ C13's trap: a tag typo must not look like a newer release. `1.2` coerced to `1.2.0`
    // would ship as an "upgrade" over `1.2.9`.
    for (const bad of ['', '1.2', '1.2.3.4', 'latest', 'v', 'nightly', '1.2.x', null, 7, {}]) {
      expect({ bad, parsed: parseVersion(bad as any) }).toEqual({ bad, parsed: null })
    }
  })
})

describe('upgrade direction (FR-14.28)', () => {
  it('allows only strictly newer', () => {
    expect(isUpgrade('1.0.0', '1.0.1')).toBe(true)
    expect(isUpgrade('1.0.0', '1.1.0')).toBe(true)
    expect(isUpgrade('1.0.0', '2.0.0')).toBe(true)
  })

  it('never downgrades', () => {
    expect(isUpgrade('2.0.0', '1.9.9')).toBe(false)
    expect(isUpgrade('1.0.1', '1.0.0')).toBe(false)
  })

  it('does not treat the running version as an upgrade', () => {
    // Reinstalling what is already running is how an updater loops.
    expect(isUpgrade('1.2.3', '1.2.3')).toBe(false)
    expect(isUpgrade('1.2.3', 'v1.2.3')).toBe(false)
  })

  it('refuses an unparseable candidate, and an unparseable current', () => {
    expect(isUpgrade('1.0.0', 'latest')).toBe(false)
    // Installing over a version nobody can read is how a rollback becomes an upgrade.
    expect(isUpgrade('garbage', '9.9.9')).toBe(false)
    expect(isUpgrade('', '9.9.9')).toBe(false)
  })

  it('sorts a prerelease before its release', () => {
    // ⚠ Backwards, and a beta looks like an upgrade over the stable build it precedes.
    expect(isUpgrade('1.2.3-beta.1', '1.2.3')).toBe(true)
    expect(isUpgrade('1.2.3', '1.2.3-beta.1')).toBe(false)
    expect(isUpgrade('1.2.3-alpha', '1.2.3-beta')).toBe(true)
  })

  it('ranks numeric prerelease identifiers numerically, not alphabetically', () => {
    // semver §11.4.3 — `beta.10` must beat `beta.2`.
    expect(isUpgrade('1.0.0-beta.2', '1.0.0-beta.10')).toBe(true)
    expect(isUpgrade('1.0.0-1', '1.0.0-alpha')).toBe(true)
  })

  it('ignores build metadata in precedence', () => {
    expect(compareVersions(parseVersion('1.0.0+a')!, parseVersion('1.0.0+b')!)).toBe(0)
  })
})

describe('the minimum version floor (FR-14.29)', () => {
  it('passes at or above the floor', () => {
    expect(meetsMinimum('1.2.3', '1.2.3')).toBe(true)
    expect(meetsMinimum('1.2.4', '1.2.3')).toBe(true)
    expect(meetsMinimum('2.0.0', '1.2.3')).toBe(true)
  })

  it('fails below it', () => {
    expect(meetsMinimum('1.2.2', '1.2.3')).toBe(false)
    // The stated purpose: a v0.1.x prototype never reaches the new endpoints.
    expect(meetsMinimum('0.1.3', '1.0.0')).toBe(false)
  })

  it('treats no configured minimum as no floor', () => {
    // ⚠ The one case that passes on unreadable input, because it is an OPERATOR's choice rather
    // than a desktop's claim. A default of "the current release" would brick the whole fleet the
    // moment someone tagged one.
    expect(meetsMinimum('anything', '')).toBe(true)
    expect(meetsMinimum('anything', undefined)).toBe(true)
    expect(meetsMinimum('anything', 'not-a-version')).toBe(true)
  })

  it('fails CLOSED when the desktop cannot state a version', () => {
    // ⚠ A desktop that has never reported an `appVersion` cannot prove it meets the floor. The
    // consequence of guessing the other way is a prototype talking to endpoints built for a
    // later protocol — and 426 is recoverable: the machine updates and re-enrolls.
    expect(meetsMinimum('', '1.0.0')).toBe(false)
    expect(meetsMinimum(undefined, '1.0.0')).toBe(false)
    expect(meetsMinimum('0.1.x', '1.0.0')).toBe(false)
  })

  it('a prerelease of the floor does not meet it', () => {
    // `1.0.0-rc.1` precedes `1.0.0`, so it is below the floor — which is the point of tagging a
    // release candidate.
    expect(meetsMinimum('1.0.0-rc.1', '1.0.0')).toBe(false)
  })
})
