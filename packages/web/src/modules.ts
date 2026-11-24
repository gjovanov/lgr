import type { ModuleManifest } from 'ui-shell/module'
import { manifest as accounting } from './modules/accounting/manifest'
import { manifest as inventory } from './modules/inventory/manifest'
import { manifest as invoicing } from './modules/invoicing/manifest'
import { manifest as payroll } from './modules/payroll/manifest'
import { manifest as reports } from './modules/reports/manifest'
import { manifest as files } from './modules/files/manifest'

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
