import type { RepositoryRegistry } from 'dal'
import { DEFAULT_ROLE_PERMISSIONS, MODULES } from 'config/constants'
import { logger } from 'services/logger'

/**
 * First-run setup: creates the default org and admin user if none exist.
 * Called on every startup — no-op if data already exists.
 */
export async function setupFirstRun(repos: RepositoryRegistry): Promise<void> {
  const { total } = await repos.orgs.findAll({} as any, { page: 0, size: 1 })
  if (total > 0) return

  logger.info('First run detected — creating default organization and admin user')

  // Generate a placeholder ownerId — will be updated to the real user ID after creation
  const placeholderOwnerId = crypto.randomUUID()

  const org = await repos.orgs.create({
    name: 'My Company',
    slug: 'my-company',
    ownerId: placeholderOwnerId,
    settings: {
      baseCurrency: 'EUR',
      fiscalYearStart: 1,
      dateFormat: 'DD.MM.YYYY',
      timezone: 'Europe/Berlin',
      locale: 'en',
      taxConfig: {
        vatEnabled: true,
        defaultVatRate: 18,
        vatRates: [
          { name: 'Standard', rate: 18 },
          { name: 'Reduced', rate: 5 },
          { name: 'Zero', rate: 0 },
        ],
        taxIdLabel: 'VAT ID',
      },
      payroll: {
        payFrequency: 'monthly',
        socialSecurityRate: 0,
        healthInsuranceRate: 0,
        pensionRate: 0,
      },
      modules: [...MODULES],
    },
    subscription: { plan: 'professional', maxUsers: 100 },
  } as any)

  const hashedPassword = await Bun.password.hash('admin123')

  const user = await repos.users.create({
    email: 'admin@localhost',
    username: 'admin',
    password: hashedPassword,
    firstName: 'Admin',
    lastName: 'User',
    role: 'admin',
    orgId: org.id,
    isActive: true,
    permissions: DEFAULT_ROLE_PERMISSIONS.admin,
  } as any)

  await repos.orgs.update(org.id, { ownerId: user.id } as any)

  logger.info({ orgId: org.id, orgSlug: 'my-company', username: 'admin' }, 'Default org and admin created')
  logger.info('Login with: org=my-company, username=admin, password=admin123')
}
