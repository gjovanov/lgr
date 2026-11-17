import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAGE_ACCESS } from 'config/access'
import { PORTAL_PAGES } from 'ui-shared/nav/page-registry'

/**
 * FR-27 P3-3 (#529), acceptance 8: the legacy screens are gone. One Role select gives a person their access, an
 * invitation names a role by its id, and the permission sets screen is a redirect to Roles & access.
 */

const PORTAL = join(import.meta.dir, '..', '..', '..', 'portal-ui', 'src')
const read = (rel: string) => readFileSync(join(PORTAL, rel), 'utf8')

describe('the permission sets screen is gone', () => {
  it('no view, and the old path redirects to Roles & access by name', () => {
    expect(existsSync(join(PORTAL, 'views/settings/PermissionSetsView.vue'))).toBe(false)
    const routes = read('routes.ts')
    expect(routes).not.toContain('PermissionSetsView')
    expect(routes).toMatch(/path: 'settings\/permission-sets', name: 'settings\.permissionSets', redirect: \{ name: 'settings\.roles' \}/)
  })

  it('no page rule and no portal page of its own', () => {
    expect(PAGE_ACCESS['/settings/permission-sets']).toBeUndefined()
    expect(PORTAL_PAGES.map(p => p.path)).not.toContain('/settings/permission-sets')
  })
})

describe('the Users and Invites screens give a role, and nothing else', () => {
  const users = read('views/settings/UsersView.vue')
  const invites = read('views/settings/InvitesView.vue')
  const store = read('store/settings.store.ts')

  it('the Users dialog has one Role select: no legacy role list, sets, permissions, areas or mismatch warning', () => {
    for (const gone of ['rolesMode', 'permissionSetIds', 'form.permissions', 'availablePermissions', 'effectivePermissions', 'effectiveAreas', 'roleSetMismatch', 'roleItems', '/permission-sets', 'permissionSets.']) {
      expect({ gone, present: users.includes(gone) }).toEqual({ gone, present: false })
    }
    expect(users.match(/<v-select/g)?.length).toBe(2) // the person's role, and the invitation's
    expect(users).toContain('data-testid="user-role-select"')
  })

  it('an invitation names its role by id only, from either screen', () => {
    for (const [file, text] of [['UsersView.vue', users], ['InvitesView.vue', invites], ['settings.store.ts', store]] as const) {
      expect({ file, legacy: /\bassignRole\b(?!Id)/.test(text) }).toEqual({ file, legacy: false })
    }
  })
})
