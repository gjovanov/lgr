/**
 * #510: an invitation the server refused, in the admin's language. The create route answers
 * `invalid_email` and `invalid_role` with a code; anything else falls back to its message.
 */
const CODES = ['invalid_email', 'invalid_role'] as const

export function inviteErrorText(e: any, t: (key: string) => string): string {
  const code = e?.response?.data?.code
  if ((CODES as readonly string[]).includes(code)) return t(`settings.inviteErrors.${code}`)
  return e?.response?.data?.message || t('common.operationFailed')
}
