import { describe, it, expect } from 'bun:test'
import { cursorWherePickLeft, type CursorNode } from '../../../web/src/modules/inventory/composables/count-cursor'

/**
 * FR-33.6 / FR-28.27 (#933): after a pick on the stock count, the cursor goes to the line's Counted only while it is
 * where the pick left it. Found in the field test on master 1a3b7da5: "Add N articles" in Details is a click, the
 * button it clicks keeps the cursor while the dialog leaves, and the rule read that as a person who had moved on. The
 * cursor then fell to <body>. The page is modelled by the selectors the rule asks about.
 */

/** An element: its tag, and which of the rule's selectors it sits inside. */
function node(tagName: string, inside: { overlay?: 'open' | 'closing'; entry?: boolean } = {}): CursorNode {
  return {
    tagName,
    closest(selectors: string) {
      if (selectors === '.v-overlay' && inside.overlay) {
        return { classList: { contains: (token: string) => token === 'v-overlay--active' && inside.overlay === 'open' } }
      }
      if (selectors === '[data-testid="count-entry"]' && inside.entry) return { classList: { contains: () => false } }
      return null
    },
  }
}

const body = node('BODY')

describe('where a pick leaves the cursor: the pick may move it to Counted', () => {
  it('nowhere: the search field it was in is replaced by a fresh one', () => {
    expect(cursorWherePickLeft(null, body)).toBe(true)
    expect(cursorWherePickLeft(body, body)).toBe(true)
  })

  it('on the entry line\'s Details button', () => {
    expect(cursorWherePickLeft(node('BUTTON', { entry: true }), body)).toBe(true)
  })

  it('on Details\' "Add N articles" while the dialog leaves (#933: the cursor ended on <body>)', () => {
    expect(cursorWherePickLeft(node('BUTTON', { overlay: 'closing' }), body)).toBe(true)
  })

  it('in Details\' search field while the dialog leaves: Enter there adds the ticked articles', () => {
    expect(cursorWherePickLeft(node('INPUT', { overlay: 'closing' }), body)).toBe(true)
  })
})

describe('a person who moved on keeps the cursor (FR-28.27)', () => {
  it('typing in the fresh entry field, already finding the next article', () => {
    expect(cursorWherePickLeft(node('INPUT', { entry: true }), body)).toBe(false)
  })

  it('in another line\'s Counted, or another field of the form', () => {
    expect(cursorWherePickLeft(node('INPUT'), body)).toBe(false)
    expect(cursorWherePickLeft(node('BUTTON'), body)).toBe(false)
  })

  it('in an overlay that is open: a select\'s list, another dialog', () => {
    expect(cursorWherePickLeft(node('DIV', { overlay: 'open' }), body)).toBe(false)
    expect(cursorWherePickLeft(node('INPUT', { overlay: 'open' }), body)).toBe(false)
  })
})
