import { onBeforeUnmount, onMounted, type Ref } from 'vue'

/**
 * FR-22.52 — the keyboard on a form's action bar (`EntityFormShell`):
 *   - Ctrl+S (⌘S) runs the form's Save, and the browser's "Save page as" never opens;
 *   - Ctrl+Enter (⌘↵) runs the form's primary action, the one that finishes the job.
 *
 * The decision is a pure function of the key event, so it is unit-tested without a browser.
 */

export type FormShortcut = 'save' | 'primary'

/** The parts of a DOM element the decision reads, so tests can hand it a plain object. */
export interface ShortcutTarget {
  tagName?: string
  isContentEditable?: boolean
  getAttribute?(name: string): string | null
  closest?(selector: string): unknown
}

export interface ShortcutKeyEvent {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  defaultPrevented: boolean
  target: ShortcutTarget | EventTarget | null
}

function asTarget(t: ShortcutKeyEvent['target']): ShortcutTarget | null {
  return t && typeof t === 'object' ? (t as ShortcutTarget) : null
}

/** Typing prose: a text area or an editable region, where Enter belongs to the text. */
function inTextEntry(t: ShortcutTarget | null): boolean {
  if (!t) return false
  if (t.isContentEditable || String(t.tagName).toUpperCase() === 'TEXTAREA') return true
  return !!t.closest?.('textarea, [contenteditable="true"], [contenteditable=""]')
}

/** A cell of a line grid, whose own keys move between rows and add one (FR-22 §5.10). */
function inLineGrid(t: ShortcutTarget | null): boolean {
  return !!t?.closest?.('table, [role="grid"]')
}

/** An open dropdown (combobox, autocomplete): Enter chooses in its list. */
function onOpenDropdown(t: ShortcutTarget | null): boolean {
  return t?.getAttribute?.('aria-expanded') === 'true'
}

/**
 * The S key, whatever the layout: with a Cyrillic layout active `key` is "с" or "ѕ", so the
 * physical key decides — exactly as the browser decides its own Ctrl+S. A Latin layout keeps
 * `key`, so a Dvorak or AZERTY S is the S its user sees.
 */
function isS(e: ShortcutKeyEvent): boolean {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase() === 's'
  return e.code === 'KeyS'
}

/** Which form shortcut this keydown asks for, or null when it is none of ours. */
export function formShortcutFor(e: ShortcutKeyEvent): FormShortcut | null {
  // Alt too is AltGr (Ctrl+Alt) on a European keyboard, where it types a character.
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return null
  if (isS(e) && !e.shiftKey) return 'save'
  if (e.key === 'Enter' && !e.shiftKey) {
    const t = asTarget(e.target)
    // Something under the focus took the key already (the line grid does, for every Enter).
    if (e.defaultPrevented || inTextEntry(t) || inLineGrid(t) || onOpenDropdown(t)) return null
    return 'primary'
  }
  return null
}

/** What a shortcut runs: the action bar's own entries. */
export interface ShortcutAction {
  handler: () => void
  disabled?: boolean
  loading?: boolean
}

/**
 * Bind the shortcuts to one mounted form. When forms nest (one opened in a dialog over another),
 * the one mounted last answers, and a dialog opened over a form keeps its keys to itself.
 */
export function useFormShortcuts(opts: {
  root: Ref<HTMLElement | null>
  save: () => ShortcutAction | null
  primary: () => ShortcutAction | null
}): void {
  const handler = (e: KeyboardEvent) => {
    const which = formShortcutFor(e)
    if (!which) return
    // Ctrl+S never reaches the browser on a form, whatever happens next.
    if (which === 'save') e.preventDefault()
    if (e.repeat || dialogOver(opts.root.value)) return
    const action = which === 'save' ? opts.save() : opts.primary()
    if (!action) return
    e.preventDefault()
    if (action.disabled || action.loading) return
    action.handler()
  }
  onMounted(() => {
    stack.push(handler)
    if (stack.length === 1) window.addEventListener('keydown', onWindowKeydown)
  })
  onBeforeUnmount(() => {
    const i = stack.lastIndexOf(handler)
    if (i >= 0) stack.splice(i, 1)
    if (!stack.length) window.removeEventListener('keydown', onWindowKeydown)
  })
}

const stack: Array<(e: KeyboardEvent) => void> = []

function onWindowKeydown(e: KeyboardEvent) {
  stack[stack.length - 1]?.(e)
}

/** An open dialog that this form is not inside (a form may itself live in a dialog). */
function dialogOver(root: HTMLElement | null): boolean {
  if (typeof document === 'undefined') return false
  for (const d of Array.from(document.querySelectorAll('.v-dialog.v-overlay--active'))) {
    if (!root || !d.contains(root)) return true
  }
  return false
}

/** True on a Mac, where the shortcuts are ⌘ rather than Ctrl. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || ''
  return /mac|iphone|ipad/i.test(p)
}

/**
 * Focus the first field a new document is typed into, once the form has rendered it: the first
 * one still empty (a receipt's date is already today; its supplier is what the person types
 * first), else the first one at all.
 *
 * The form may still be loading (a number to peek, a list to fetch), so it looks again for a
 * moment. It leaves the focus alone when it is already inside the form (the form placed it, or
 * the person clicked) or in a field elsewhere (the person is typing there). A select is skipped:
 * it takes no typing, and focusing it opens nothing.
 */
export function focusFirstField(root: () => HTMLElement | null, isAlive: () => boolean, waitMs = 2000): void {
  const until = Date.now() + waitMs
  const attempt = () => {
    const el = root()
    if (!el || !isAlive()) return
    const active = document.activeElement as HTMLElement | null
    if (active && active !== document.body && el.contains(active)) return
    if (active && active !== document.body && isField(active)) return
    const field = firstField(el)
    if (field) {
      focusQuietly(field)
      return
    }
    if (Date.now() < until) setTimeout(attempt, 100)
  }
  setTimeout(attempt, 0)
}

/**
 * Focus without opening anything. An autocomplete whose list arrives while it holds the focus
 * opens that list by itself (Vuetify), over the fields below it, where the next click would pick
 * a partner by accident. So a list that opens before the person has typed or clicked is closed
 * again; typing in the field opens it as usual.
 */
function focusQuietly(field: HTMLElement): void {
  field.focus()
  if (field.getAttribute('role') !== 'combobox') return
  let done = false
  const finish = () => {
    if (done) return
    done = true
    observer.disconnect()
    window.removeEventListener('keydown', finish, true)
    window.removeEventListener('pointerdown', finish, true)
    clearTimeout(timer)
  }
  const observer = new MutationObserver(() => {
    if (field.getAttribute('aria-expanded') !== 'true') return
    finish()
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  observer.observe(field, { attributes: true, attributeFilter: ['aria-expanded'] })
  // The person acted first: from here the list is theirs.
  window.addEventListener('keydown', finish, true)
  window.addEventListener('pointerdown', finish, true)
  const timer = setTimeout(finish, 5000)
}

const FIELD_SELECTOR = [
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="image"])',
  'textarea',
].join(', ')

function isField(el: HTMLElement): boolean {
  return el.matches?.(`${FIELD_SELECTOR}, select, [contenteditable="true"]`) ?? false
}

function firstField(root: HTMLElement): HTMLElement | null {
  const typable = Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(FIELD_SELECTOR)).filter(
    (el) =>
      !el.disabled &&
      !el.readOnly &&
      el.getAttribute('inputmode') !== 'none' && // a v-select: nothing to type
      !el.closest('[aria-hidden="true"], [inert]') &&
      el.getClientRects().length > 0, // rendered (not in a collapsed panel or behind v-show)
  )
  return typable.find(isEmptyField) ?? typable[0] ?? null
}

/**
 * No value yet. An autocomplete shows its choice beside an empty input, so the choice it shows
 * decides. Not Vuetify's `v-field--dirty`: an autocomplete bound to '' counts as holding a value.
 */
function isEmptyField(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (el.value !== '') return false
  const shown = el.closest('.v-field')?.querySelector('.v-autocomplete__selection, .v-select__selection, .v-combobox__selection, .v-chip')
  return !shown?.textContent?.trim()
}
