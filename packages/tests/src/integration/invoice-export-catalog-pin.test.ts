import { describe, it, expect } from 'bun:test'
import { ALL_COLUMN_KEYS } from 'ui-shared/composables/useExportColumns'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Regression: the server-side ALLOWED_COLUMN_KEYS Set in
 * invoice-export.controller.ts must be a superset of every column key the UI
 * catalog offers. If the UI adds a key but the backend rejects it, the Download
 * button silently 400s.
 *
 * We parse the controller source for the string literals rather than importing it
 * (to avoid booting Mongoose / AppAuthService just for a static check).
 */
describe('Export column catalog ↔ backend allowlist', () => {
  it('every UI column key is in the backend ALLOWED_COLUMN_KEYS set', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../../../packages/invoicing-api/src/controllers/invoice-export.controller.ts'),
      'utf-8',
    )
    const match = src.match(/ALLOWED_COLUMN_KEYS\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/)
    expect(match, 'Could not find ALLOWED_COLUMN_KEYS literal in controller').toBeTruthy()
    const serverKeys = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1])

    for (const key of ALL_COLUMN_KEYS) {
      expect(serverKeys).toContain(key)
    }
  })
})
