import { config } from 'config'

/**
 * The platform's operators: LGR has no permission for them, so they are an allow-list of user ids
 * and emails, `BACKUP_SYS_ADMINS` (the backup administration's, then the All-servers page's and the
 * licences'). ⚠ An org `admin` is not one: an empty list closes these pages to everyone.
 *
 * Import-pure apart from the config.
 */
export function isSysAdmin(user: { id?: unknown; email?: unknown } | null | undefined): boolean {
  const allow = config.backup.sysAdmins.map(s => String(s).toLowerCase())
  if (!allow.length || !user) return false
  const id = String(user.id || '').toLowerCase()
  const email = String(user.email || '').toLowerCase()
  return allow.includes(id) || (!!email && allow.includes(email))
}
