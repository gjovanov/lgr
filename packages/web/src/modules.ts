import type { ModuleManifest } from 'ui-shell/module'
import { manifest as accounting } from '../../accounting-ui/src/manifest'
import { manifest as inventory } from '../../inventory-ui/src/manifest'
import { manifest as invoicing } from '../../invoicing-ui/src/manifest'
import { manifest as payroll } from '../../payroll-ui/src/manifest'
import { manifest as reports } from '../../reports-ui/src/manifest'
import { manifest as files } from '../../files-ui/src/manifest'

/**
 * FR-24.3/24.11: every domain module of the one SPA. Adding a module is a manifest and a line here
 * (and its row in `APP_REGISTRY`). The till is part of invoicing's.
 */
export const MODULES: readonly ModuleManifest[] = [invoicing, inventory, accounting, payroll, reports, files]

/** The module a route belongs to, from its shell record's `meta.module`. */
export function moduleOf(route: { matched: ReadonlyArray<{ meta: Record<string | number | symbol, unknown> }> }): ModuleManifest | null {
  const id = route.matched.find(r => typeof r.meta.module === 'string')?.meta.module
  return MODULES.find(m => m.id === id) ?? null
}
