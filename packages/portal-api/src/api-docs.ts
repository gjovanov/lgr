import { Elysia } from 'elysia'
import swagger from '@elysiajs/swagger'
import { nodeRole, type NodeRole } from 'config'

/**
 * The API docs: `/swagger` (Scalar's page) and `/swagger/json` (the OpenAPI document), S-11.
 *
 * The OpenAPI document is the whole route table with every body schema, and it was served to anyone
 * who could reach lgrai.app. Who is served it now:
 *
 * - **A master: never** (FR-20 AC 66). The page loads its viewer from a CDN, and a master serves no
 *   third-party script. `SWAGGER_ENABLED` does not change that.
 * - **Global in production: not unless an operator asks**, with `SWAGGER_ENABLED=true` (or `1`).
 * - **Global anywhere else** (`bun run dev`, the tests): served, as before. `SWAGGER_ENABLED=false`
 *   (or `0`) turns it off there too.
 *
 * "Production" is `NODE_ENV=production`, the signal every production-only guard reads (`config`'s
 * `requiredSecret`, the CORS allow-list, `Secure` cookies). Global sets it in `lgr-config` (S-24), and
 * the supervisor sets it on every master and lets no operator setting override it
 * (`packages/server/src/config.rs`). A server package keeps it a run-time read (`serverBuildOptions`).
 * ⚠ A global started without `NODE_ENV=production` serves the docs, as it would also skip the secret
 * guards: S-24's lesson is to set it, not to guess production from something else.
 *
 * Any other `SWAGGER_ENABLED` value is ignored, so a typo falls back to the default for the
 * environment, which in production is off.
 */
/** The variables read: `NODE_ENV` and `SWAGGER_ENABLED`. `process.env` unless a test passes its own. */
export type ApiDocsEnv = Record<string, string | undefined>

export function apiDocsServed(role: NodeRole = nodeRole(), env: ApiDocsEnv = process.env): boolean {
  if (role !== 'global') return false
  const flag = (env.SWAGGER_ENABLED ?? '').trim().toLowerCase()
  if (flag === 'true' || flag === '1') return true
  if (flag === 'false' || flag === '0') return false
  return env.NODE_ENV !== 'production'
}

/** The plugin `unified.ts` mounts: Swagger when `apiDocsServed`, otherwise nothing at all. */
export function apiDocs(role: NodeRole = nodeRole(), env: ApiDocsEnv = process.env) {
  if (!apiDocsServed(role, env)) return new Elysia()
  return swagger({
    documentation: {
      info: { title: 'LGR Unified API', version: '0.1.0', description: 'LGR ERP — All modules unified' },
      tags: [
        { name: 'Auth', description: 'Authentication & OAuth' },
        { name: 'Org', description: 'Organization management' },
        { name: 'Users', description: 'User management' },
        { name: 'Invites', description: 'Invitation management' },
        { name: 'Apps', description: 'App Hub' },
        { name: 'Billing', description: 'Stripe billing' },
        { name: 'Files', description: 'File management' },
        { name: 'Notifications', description: 'Notifications' },
        { name: 'Accounting', description: 'Chart of Accounts, Journal Entries, Reports' },
        { name: 'Invoicing', description: 'Invoices, Contacts, Payments' },
        { name: 'Warehouse', description: 'Products, Stock, Movements' },
        { name: 'Payroll', description: 'Employees, Payroll Runs, Payslips' },
        { name: 'Fiscal', description: 'Fiscal Devices, Workstations, SUPTO' },
        { name: 'POS', description: 'Point of Sale' },
      ],
    },
  })
}
