/**
 * #510: an invitation the server refused, in the admin's language. The create route answers
 * `invalid_email` with a code; anything else (a role this admin may not give, FR-27.8) falls back to its message.
 * FR-27 P3-3 (#529): `invalid_role` is gone with the legacy role field, which the route now refuses outright.
 */
const CODES = ['invalid_email'] as const

export function inviteErrorText(e: any, t: (key: string) => string): string {
  const code = e?.response?.data?.code
  if ((CODES as readonly string[]).includes(code)) return t(`settings.inviteErrors.${code}`)
  return e?.response?.data?.message || t('common.operationFailed')
}
