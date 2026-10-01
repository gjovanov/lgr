/**
 * Version comparison for the desktop fleet (FR-14.28, FR-14.29).
 *
 * ⚠ Import-pure, and deliberately mirrored by `packages/desktop/src-tauri/src/update.rs`. The
 * two sides have to agree about what "newer" means: the hub decides whether a desktop is below
 * `DESKTOP_MIN_VERSION`, and the desktop decides whether a manifest is an upgrade. A
 * disagreement is a fleet that either updates in a loop or refuses to update at all.
 *
 * ⚠ **An unparseable version is NOT an upgrade, and NOT acceptable.** A tag typo must not look
 * like a newer release (C13's trap), and a desktop that cannot state a version it meets cannot
 * be assumed to meet the minimum — both directions fail closed.
 */

export interface SemVer {
  major: number
  minor: number
  patch: number
  /** Everything after `-`, e.g. `beta.2`. Empty for a release. */
  prerelease: string
}

/**
 * Parse `1.2.3`, `v1.2.3`, `1.2.3-beta.1`, `1.2.3+build` — and refuse everything else.
 *
 * ⚠ Strict on purpose. `1.2` and `1.2.3.4` return null rather than being coerced: a build that
 * tags `v1.2` would otherwise compare as `1.2.0` and could ship as an "upgrade" over `1.2.9`.
 */
export function parseVersion(raw: unknown): SemVer | null {
  if (typeof raw !== 'string') return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? '',
  }
}

/**
 * -1 / 0 / 1, semver precedence.
 *
 * ⚠ A prerelease sorts BEFORE its release (`1.2.3-beta < 1.2.3`), per semver §11. Getting this
 * backwards would let a beta look like an upgrade over the stable build it precedes, which is
 * exactly the downgrade the rules forbid.
 */
export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1

  if (a.prerelease === b.prerelease) return 0
  // A release outranks any prerelease of the same version.
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1

  const ai = a.prerelease.split('.')
  const bi = b.prerelease.split('.')
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const x = ai[i]
    const y = bi[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    // Numeric identifiers always have lower precedence than alphanumeric ones (semver §11.4.3).
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (xn !== yn) {
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * Does `current` satisfy `minimum`?
 *
 * ⚠ Fails CLOSED on both arguments. An unparseable `current` — including a desktop that has
 * never reported one — does not satisfy any minimum: it cannot prove it is new enough, and the
 * consequence of being wrong is a prototype talking to endpoints built for a later protocol
 * (FR-14.29). An unparseable or empty `minimum` means no minimum is configured, which is the
 * one case that passes, because that is an operator choice rather than a desktop's claim.
 */
export function meetsMinimum(current: unknown, minimum: unknown): boolean {
  const min = parseVersion(minimum)
  if (!min) return true

  const cur = parseVersion(current)
  if (!cur) return false

  return compareVersions(cur, min) >= 0
}

/**
 * Is `candidate` strictly newer than `current`? The updater's "should I install this" rule.
 *
 * ⚠ **No downgrade, ever** (FR-14.28), and equality is not an upgrade either — reinstalling the
 * running version is how an updater loops. An unparseable candidate is refused outright.
 */
export function isUpgrade(current: unknown, candidate: unknown): boolean {
  const cur = parseVersion(current)
  const next = parseVersion(candidate)
  if (!next) return false
  // ⚠ An unparseable CURRENT is not a reason to install anything. It is a reason to look at the
  // machine: installing over a version nobody can read is how a rollback becomes an upgrade.
  if (!cur) return false
  return compareVersions(next, cur) > 0
}
