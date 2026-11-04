import { config } from 'config'
import { ROLES } from 'config/constants'
import { sendEmail } from './email.service.js'
import { logger } from '../logger/logger.js'

/**
 * #510: an invitation, as the person it names receives it.
 *
 * Until this an "email invite" stored the address and mailed nothing: the person never heard of it
 * unless the admin copied the link out of the list and sent it themselves.
 */

type Locale = 'en' | 'bg' | 'de' | 'mk'

const INVITE_EMAIL: Record<Locale, { subject: string; intro: string; button: string; how: string; expires: string }> = {
  en: {
    subject: '{inviter} invited you to {org} on LGR',
    intro: '{inviter} invited you to join {org} on LGR.',
    button: 'Accept the invitation',
    how: 'Sign in, or create an account, with {email} to join.',
    expires: 'The invitation expires on {date}.',
  },
  bg: {
    subject: '{inviter} ви покани в {org} в LGR',
    intro: '{inviter} ви покани да се присъедините към {org} в LGR.',
    button: 'Приемете поканата',
    how: 'Влезте или създайте акаунт с адреса {email}, за да се присъедините.',
    expires: 'Поканата изтича на {date}.',
  },
  de: {
    subject: '{inviter} hat Sie zu {org} in LGR eingeladen',
    intro: '{inviter} hat Sie eingeladen, {org} in LGR beizutreten.',
    button: 'Einladung annehmen',
    how: 'Melden Sie sich mit {email} an oder legen Sie damit ein Konto an, um beizutreten.',
    expires: 'Die Einladung läuft am {date} ab.',
  },
  mk: {
    subject: '{inviter} ве покани во {org} во LGR',
    intro: '{inviter} ве покани да се приклучите на {org} во LGR.',
    button: 'Прифатете ја поканата',
    how: 'Најавете се или создадете сметка со адресата {email} за да се приклучите.',
    expires: 'Поканата истекува на {date}.',
  },
}

/** The link an invitation carries: the portal's landing page for its code. */
export function inviteUrl(code: string): string {
  return `${config.email.appUrl}/invite/${encodeURIComponent(code)}`
}

/** A plausible address: something, an @, a domain with a dot. The mail provider is the real check. */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

export function isRole(value: string): boolean {
  return (ROLES as readonly string[]).includes(value)
}

export type InviteMailOutcome = { sent: true; queued?: true } | { sent: false; reason: 'not_configured' | 'provider_error' }

/**
 * Mail an invitation to the address it names, in the org's language. Never throws: the invite
 * exists either way, and the admin is told whether the mail went out so they can share the link
 * themselves when it did not.
 */
export async function mailInvite(
  invite: { code: string; targetEmail?: string | null; expiresAt?: Date | null; _id?: unknown },
  org: { _id?: unknown; name: string; settings?: { locale?: string; timezone?: string } },
  inviterName: string,
): Promise<InviteMailOutcome | null> {
  if (!invite.targetEmail) return null
  const locale = (org.settings?.locale && org.settings.locale in INVITE_EMAIL ? org.settings.locale : 'en') as Locale
  const text = INVITE_EMAIL[locale]
  // Function replacers: a `$` in a name is text, never a replacement pattern.
  const date = invite.expiresAt ? expiryDate(invite.expiresAt, locale, org.settings?.timezone) : ''
  const fill = (s: string) => s
    .replace('{inviter}', () => inviterName)
    .replace('{org}', () => org.name)
    .replace('{email}', () => invite.targetEmail!)
    .replace('{date}', () => date)
  const url = inviteUrl(invite.code)

  const result = await sendEmail({
    to: invite.targetEmail,
    subject: fill(text.subject),
    html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
<p>${esc(fill(text.intro))}</p>
<p style="margin: 32px 0;">
  <a href="${esc(url)}" style="background:#1976d2;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">${esc(text.button)}</a>
</p>
<p style="color:#666;font-size:13px;">${esc(fill(text.how))}${invite.expiresAt ? ` ${esc(fill(text.expires))}` : ''}</p>
</div>`,
    orgId: org._id ? String(org._id) : undefined,
    entityType: 'invite',
    entityId: invite._id ? String(invite._id) : undefined,
  }).catch(err => {
    logger.warn({ err, inviteId: invite._id }, 'Failed to send an invitation email')
    return { ok: false as const, reason: 'provider_error' as const }
  })

  if (result.ok) return result.queued ? { sent: true, queued: true } : { sent: true }
  // With no SendGrid key (local dev) say where the link is. Never in production: there a missing key
  // is a misconfiguration, and the admin is shown the link in the dialog anyway.
  if (result.reason === 'not_configured' && process.env.NODE_ENV !== 'production') {
    logger.warn({ to: invite.targetEmail, inviteUrl: url }, 'Email not configured — invitation link for local use')
  }
  return { sent: false, reason: result.reason }
}

function expiryDate(at: Date, locale: Locale, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(at)
  } catch {
    return at.toISOString().slice(0, 16).replace('T', ' ')
  }
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
