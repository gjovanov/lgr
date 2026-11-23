/**
 * What a sign-in refusal says to the person, by CODE (multi-org sign-in, Phase 3).
 *
 * The OAuth callback sends the browser back to `/auth/login?error=<code>`. Only codes are
 * translated here; anything else becomes the generic message, so a crafted link cannot put
 * arbitrary text on the sign-in page.
 */
export function signInErrorMessage(
  code: string,
  t: (key: string) => string,
  te: (key: string) => boolean,
): string {
  if (/^[a-z_]{2,40}$/.test(code)) {
    if (te(`auth.errors.${code}`)) return t(`auth.errors.${code}`)
    if (te(`identity.errors.${code}`)) return t(`identity.errors.${code}`)
  }
  return t('auth.errors.failed')
}
