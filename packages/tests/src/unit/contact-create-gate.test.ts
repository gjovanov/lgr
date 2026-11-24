import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every document form can make a new contact from its party picker: the last entry of the dropdown, and the button
 * beside the select. Both need `contacts.create`, the capability the Contacts page's own New button asks (FR-27.7's
 * `v-cap`). A role may write documents and not contacts, and the server refuses its save (`writes('contacts')`), so
 * the dialog is not offered to it.
 *
 * Read from the source: these are components, which `access-read-only.test.ts` (views only) does not scan, and nothing
 * here mounts a Vue tree.
 */
const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const GATE = `v-cap="'contacts.create'"`

describe('a new contact from a document form needs contacts.create', () => {
  it("the dropdown's create entry sits inside the gate", () => {
    const src = read('packages/ui-shared/src/components/ContactAutocompleteWithCreate.vue')
    const slot = src.match(/<template #append-item>([\s\S]*?)<\/template>/)?.[1] ?? ''
    expect(slot).toContain('openCreateDialog')
    expect(slot).toContain(GATE)
    expect(slot.indexOf(GATE)).toBeLessThan(slot.indexOf('openCreateDialog'))
  })

  it("the banner's button carries the same gate", () => {
    const src = read('packages/web/src/modules/invoicing/components/document-form/DocumentForm.vue')
    const button = src.match(/<v-btn\b(?:(?!<v-btn\b|\/>)[\s\S])*data-testid="create-contact-btn"(?:(?!\/>)[\s\S])*\/>/)?.[0] ?? ''
    expect(button).toContain('openCreateDialog')
    expect(button).toContain(GATE)
  })
})
