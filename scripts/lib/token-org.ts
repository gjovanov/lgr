/**
 * An `LGR_TOKEN` names ONE org: the org of the browser tab or sign-in it was copied from.
 *
 * Since multi-org sign-in (2026-10) a tab can switch org, so a token copied from it may name a
 * different org than the `--org` the script was told. The scripts used to take whatever org the
 * token said and print `--org` as if they matched, so they would have imported, booked or
 * transferred into that other org without a word. Refuse instead.
 *
 * `me` is the answer of `GET /api/auth/me`, which carries the session's org.
 */
export function assertTokenOrg(me: { org?: { slug?: string } | null } | null | undefined, orgSlug: string | undefined): void {
  const actual = me?.org?.slug
  if (!orgSlug || !actual || actual === orgSlug.toLowerCase()) return
  console.error(
    `LGR_TOKEN is signed in to "${actual}", not --org ${orgSlug}. ` +
      `Copy a token from a tab in ${orgSlug}, or sign in with LGR_USERNAME + LGR_PASSWORD instead.`,
  )
  process.exit(2)
}
