import { describe, it, expect } from 'bun:test'
import { formShortcutFor, type ShortcutKeyEvent, type ShortcutTarget } from 'ui-shared/composables/form-shortcuts'

/**
 * FR-22.52 — Ctrl+S saves, Ctrl+Enter runs the form's primary action.
 *
 * The decision is pure, so the cases that matter are asserted here without a browser: the
 * Bulgarian keyboard layout (the staff type in Cyrillic), AltGr, and the places a shortcut must
 * leave the key alone — a text area, the line grid whose Enter adds a line (§5.10), an open
 * dropdown.
 */

/** A stand-in element: a tag, and the ancestors `closest` can find. */
function el(tagName: string, opts: { ancestors?: string[]; attrs?: Record<string, string>; editable?: boolean } = {}): ShortcutTarget {
  const ancestors = opts.ancestors ?? []
  return {
    tagName,
    isContentEditable: !!opts.editable,
    getAttribute: (name) => opts.attrs?.[name] ?? null,
    closest: (selector) =>
      selector.split(',').map((s) => s.trim()).some((s) => ancestors.includes(s) || s === tagName.toLowerCase()) ? {} : null,
  }
}

const input = el('INPUT')

function key(k: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    key: k,
    code: mods.code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: input,
    ...mods,
  }
}

describe('Ctrl+S — save', () => {
  it('Ctrl+S and ⌘S save', () => {
    expect(formShortcutFor(key('s', { ctrlKey: true, code: 'KeyS' }))).toBe('save')
    expect(formShortcutFor(key('S', { ctrlKey: true, code: 'KeyS' }))).toBe('save')
    expect(formShortcutFor(key('s', { metaKey: true, code: 'KeyS' }))).toBe('save')
  })

  it('on a Cyrillic layout the physical S key decides, as it does for the browser', () => {
    expect(formShortcutFor(key('с', { ctrlKey: true, code: 'KeyS' }))).toBe('save') // phonetic
    expect(formShortcutFor(key('я', { ctrlKey: true, code: 'KeyS' }))).toBe('save') // БДС
    expect(formShortcutFor(key('с', { ctrlKey: true, code: 'KeyC' }))).toBeNull()
  })

  it('on a Latin layout the letter decides (a Dvorak S is where its user sees it)', () => {
    expect(formShortcutFor(key('o', { ctrlKey: true, code: 'KeyS' }))).toBeNull()
    expect(formShortcutFor(key('s', { ctrlKey: true, code: 'Semicolon' }))).toBe('save')
  })

  it('saves from a text area too: Ctrl+S means nothing there to take away', () => {
    expect(formShortcutFor(key('s', { ctrlKey: true, code: 'KeyS', target: el('TEXTAREA') }))).toBe('save')
  })

  it('leaves S alone without Ctrl, with Shift, with AltGr, and while composing', () => {
    expect(formShortcutFor(key('s', { code: 'KeyS' }))).toBeNull()
    expect(formShortcutFor(key('S', { ctrlKey: true, shiftKey: true, code: 'KeyS' }))).toBeNull()
    expect(formShortcutFor(key('ś', { ctrlKey: true, altKey: true, code: 'KeyS' }))).toBeNull()
    expect(formShortcutFor(key('s', { ctrlKey: true, code: 'KeyS', isComposing: true }))).toBeNull()
  })
})

describe('Ctrl+Enter — the primary action', () => {
  it('Ctrl+Enter and ⌘Enter run it from an ordinary field', () => {
    expect(formShortcutFor(key('Enter', { ctrlKey: true }))).toBe('primary')
    expect(formShortcutFor(key('Enter', { metaKey: true }))).toBe('primary')
    expect(formShortcutFor(key('Enter', { ctrlKey: true, target: el('BUTTON') }))).toBe('primary')
    expect(formShortcutFor(key('Enter', { ctrlKey: true, target: null }))).toBe('primary')
  })

  it('never from a text area or an editable region, where Enter belongs to the text', () => {
    expect(formShortcutFor(key('Enter', { ctrlKey: true, target: el('TEXTAREA') }))).toBeNull()
    expect(formShortcutFor(key('Enter', { ctrlKey: true, target: el('DIV', { editable: true }) }))).toBeNull()
    expect(formShortcutFor(key('Enter', { ctrlKey: true, target: el('SPAN', { ancestors: ['[contenteditable="true"]'] }) }))).toBeNull()
  })

  it('never from the line grid, whose own Enter moves between rows and adds one (§5.10)', () => {
    expect(formShortcutFor(key('Enter', { ctrlKey: true, target: el('INPUT', { ancestors: ['table'] }) }))).toBeNull()
    expect(formShortcutFor(key('Enter', { ctrlKey: true, target: el('INPUT', { ancestors: ['[role="grid"]'] }) }))).toBeNull()
  })

  it('never on an open dropdown, or once something else took the key', () => {
    expect(formShortcutFor(key('Enter', { ctrlKey: true, target: el('INPUT', { attrs: { 'aria-expanded': 'true' } }) }))).toBeNull()
    expect(formShortcutFor(key('Enter', { ctrlKey: true, target: el('INPUT', { attrs: { 'aria-expanded': 'false' } }) }))).toBe('primary')
    expect(formShortcutFor(key('Enter', { ctrlKey: true, defaultPrevented: true }))).toBeNull()
  })

  it('a plain Enter, Shift+Enter and Alt+Enter are not shortcuts', () => {
    expect(formShortcutFor(key('Enter'))).toBeNull()
    expect(formShortcutFor(key('Enter', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(formShortcutFor(key('Enter', { ctrlKey: true, altKey: true }))).toBeNull()
  })
})

describe('everything else', () => {
  it('passes through', () => {
    for (const k of ['a', 'p', 'z', 'Escape', 'Tab', 'F5']) {
      expect(formShortcutFor(key(k, { ctrlKey: true }))).toBeNull()
    }
  })
})
