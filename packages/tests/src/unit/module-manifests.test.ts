import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import type { ModuleManifest, ModuleMenuItem } from 'ui-shell/module'
import { inModule, pendingRestoreUrl } from 'ui-shared/nav/open-page'
import { APP_NAV_META } from 'ui-shared/nav/page-registry'
import { manifest as accounting } from '../../../accounting-ui/src/manifest'
import { manifest as inventory } from '../../../inventory-ui/src/manifest'
import { manifest as invoicing } from '../../../invoicing-ui/src/manifest'
import { manifest as pos } from '../../../invoicing-ui/src/pos/manifest'
import { manifest as payroll } from '../../../payroll-ui/src/manifest'
import { manifest as reports } from '../../../reports-ui/src/manifest'
import { manifest as files } from '../../../files-ui/src/manifest'

/**
 * FR-24.3/24.4: each module is a manifest, and every app-relative path it names (menu entries,
 * breadcrumbs, back-to values) resolves against its OWN route table. Those paths no longer depend
 * on a router's base, so the same table mounts unchanged under one SPA (Phase 2).
 */

const MANIFESTS: ModuleManifest[] = [accounting, inventory, invoicing, pos, payroll, reports, files]
const PACKAGES = join(import.meta.dirname, '..', '..', '..')

/** Every route of the module as a regex over module-relative paths ("/orders/:id"). */
function routePatterns(m: ModuleManifest): RegExp[] {
  const out: RegExp[] = []
  const walk = (records: any[], parent: string) => {
    for (const r of records) {
      const path = r.path.startsWith('/') ? r.path : `${parent}/${r.path}`.replace(/\/+$/, '') || '/'
      const source = path.replace(/:[A-Za-z_]+\([^)]*\)[*+?]?|:[A-Za-z_]+\??/g, '[^/]+')
      out.push(new RegExp(`^${source === '/' ? '/?' : source}/?$`))
      if (r.children) walk(r.children, path === '/' ? '' : path)
    }
  }
  walk(m.routes, '')
  return out
}

function resolves(m: ModuleManifest, to: string): boolean {
  const pathname = to.split(/[?#]/)[0]
  return routePatterns(m).some(re => re.test(pathname))
}

function menuPaths(items: ModuleMenuItem[] | null): string[] {
  return (items ?? []).flatMap(i => [...(i.to ? [i.to] : []), ...menuPaths(i.children ?? null)])
}

function breadcrumbPaths(records: any[]): string[] {
  return records.flatMap(r => [
    ...((r.meta?.breadcrumb ?? []) as { to?: string }[]).flatMap(c => (c.to ? [c.to] : [])),
    ...breadcrumbPaths(r.children ?? []),
  ])
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}

/** Which module a source file's back-to values belong to. */
function moduleOf(rel: string): ModuleManifest | undefined {
  if (rel.startsWith('invoicing-ui/src/pos/')) return pos
  const id = rel.split('/')[0].replace(/-ui$/, '')
  return MANIFESTS.find(m => m.id === id)
}

describe('FR-24.3: one manifest per module', () => {
  it('names an app the registry knows, at the base the registry gives it', () => {
    for (const m of MANIFESTS) expect({ id: m.id, base: m.base }).toEqual({ id: m.id, base: APP_NAV_META[m.id].base })
  })

  it('redirects by name, never to a path, which would name a router base', () => {
    const misses: string[] = []
    const walk = (id: string, records: any[]) => {
      for (const r of records) {
        const target = typeof r.redirect === 'function' ? r.redirect({ params: { id: 'x' }, query: {} }) : r.redirect
        if (typeof target === 'string' || (target && typeof target === 'object' && 'path' in target)) misses.push(` `)
        if (r.children) walk(id, r.children)
      }
    }
    for (const m of MANIFESTS) walk(m.id, m.routes)
    expect(misses).toEqual([])
  })

  it('names routes relative to the module: no route path names a base', () => {
    for (const m of MANIFESTS) {
      for (const r of [...m.routes, ...(m.outside ?? [])]) {
        expect({ id: m.id, path: r.path, absolute: r.path.startsWith('/') }).toEqual({ id: m.id, path: r.path, absolute: false })
      }
    }
  })
})

describe('FR-24.4: every app-relative path resolves in its own module', () => {
  it('menus', () => {
    const misses = MANIFESTS.flatMap(m => menuPaths(m.menu).filter(p => !resolves(m, p) && !(m.outside ?? []).some(o => `/${o.path}` === p)).map(p => `${m.id} ${p}`))
    expect(misses).toEqual([])
  })

  it('breadcrumbs', () => {
    const misses = MANIFESTS.flatMap(m => breadcrumbPaths(m.routes).filter(p => !resolves(m, p)).map(p => `${m.id} ${p}`))
    expect(misses).toEqual([])
  })

  it('back-to values in the views and form configs', () => {
    const misses: string[] = []
    const pattern = /back-to="(\/[^"]*)"|backTo:\s*'(\/[^']*)'/g
    for (const root of ['accounting-ui', 'inventory-ui', 'invoicing-ui', 'payroll-ui', 'reports-ui', 'files-ui']) {
      for (const file of sources(join(PACKAGES, root, 'src'))) {
        const rel = relative(PACKAGES, file).replace(/\\/g, '/')
        const m = moduleOf(rel)
        for (const hit of readFileSync(file, 'utf8').matchAll(pattern)) {
          const to = hit[1] ?? hit[2]
          if (!m || !resolves(m, to)) misses.push(`${rel}: ${to}`)
        }
      }
    }
    expect(misses).toEqual([])
  })
})

describe('inModule and the pending-changes restore', () => {
  const at = (path: string) => ({ matched: [{ path, meta: { module: 'x' } }] })

  it('prefixes a module-relative path with the path of its shell record', () => {
    expect(inModule(at('/'), '/orders')).toBe('/orders')
    expect(inModule(at('/pos'), '/orders')).toBe('/pos/orders')
    expect(inModule(at('/invoicing'), '/orders/1?x=1')).toBe('/invoicing/orders/1?x=1')
    expect(inModule({ matched: [] }, '/orders')).toBe('/orders')
    expect(inModule(at('/pos'), 'relative')).toBe('relative')
  })

  it('reopens an entry recorded relative to its app, or inside a bigger SPA, on the same page', () => {
    expect(pendingRestoreUrl({ appId: 'inventory', routePath: '/movements/1', id: 'e1' })).toBe('/inventory/movements/1?restore=e1')
    expect(pendingRestoreUrl({ appId: 'pos', routePath: '/devices/1', id: 'e2' })).toBe('/invoicing/pos/devices/1?restore=e2')
    expect(pendingRestoreUrl({ appId: 'invoicing', routePath: '/pos/devices/1', id: 'e3' })).toBe('/invoicing/pos/devices/1?restore=e3')
    expect(pendingRestoreUrl({ appId: 'invoicing', routePath: '/invoicing/invoices/1/edit', id: 'e4' })).toBe('/invoicing/invoices/1/edit?restore=e4')
    expect(pendingRestoreUrl({ appId: 'inventory', id: 'e5' })).toBeNull()
  })
})
