import { describe, it, expect } from 'bun:test'
import { cursorWherePickLeft, type CursorNode } from '../../../ui-shared/src/composables/pick-cursor'

/**
 * FR-28.27 (#933, #974): after a pick, the cursor goes to the line's quantity only while it is where the pick left it.
 * Found in the field test on master 1a3b7da5 (the stock count), then on invoice and order lines: "Add N articles" in
 * Details is a click, the button it clicks keeps the cursor while the dialog leaves, and the rule read that as a
 * person who had moved on. The cursor then fell to <body>. The page is modelled by the selectors the rule asks about,
 * and each form's own idea of "the line the pick came from" by what it hands the rule.
 */

/** An element: its tag, and where it sits (an overlay, the count's entry line, the line row a pick came from). */
interface Node extends CursorNode { entry?: boolean; pickRow?: boolean }
function node(tagName: string, inside: { overlay?: 'open' | 'closing'; entry?: boolean; pickRow?: boolean } = {}): Node {
  return {
    tagName,
    entry: inside.entry,
    pickRow: inside.pickRow,
    closest(selectors: string) {
      if (selectors === '.v-overlay' && inside.overlay) {
        return { classList: { contains: (token: string) => token === 'v-overlay--active' && inside.overlay === 'open' } }
      }
      return null
    },
  }
}

/** The count: its entry line's Details button, never the entry field (the fresh search). */
const countLine = (n: Node) => !!n.entry && n.tagName !== 'INPUT'
/** An invoice's or an order's line row: its search field and Details button alike. */
const docLine = (n: Node) => !!n.pickRow

const body = node('BODY')
const FORMS = [['the count', countLine], ['invoice and order lines', docLine]] as const

describe('where a pick leaves the cursor: the pick may move it to the quantity', () => {
  for (const [form, onLine] of FORMS) {
    it(`${form}: nowhere (the field it was in is gone)`, () => {
      expect(cursorWherePickLeft(null, body, onLine)).toBe(true)
      expect(cursorWherePickLeft(body, body, onLine)).toBe(true)
    })

    it(`${form}: on Details' "Add N articles" while the dialog leaves (#933, #974: the cursor ended on <body>)`, () => {
      expect(cursorWherePickLeft(node('BUTTON', { overlay: 'closing' }), body, onLine)).toBe(true)
    })

    it(`${form}: in Details' search field while the dialog leaves: Enter there adds the ticked articles`, () => {
      expect(cursorWherePickLeft(node('INPUT', { overlay: 'closing' }), body, onLine)).toBe(true)
    })
  }

  it('the count: on the entry line\'s Details button', () => {
    expect(cursorWherePickLeft(node('BUTTON', { entry: true }), body, countLine)).toBe(true)
  })

  it('invoice and order lines: in the line\'s own search field (a pick from its list), or on its Details button', () => {
    expect(cursorWherePickLeft(node('INPUT', { pickRow: true }), body, docLine)).toBe(true)
    expect(cursorWherePickLeft(node('BUTTON', { pickRow: true }), body, docLine)).toBe(true)
  })
})

describe('a person who moved on keeps the cursor (FR-28.27)', () => {
  it('the count: typing in the fresh entry field, already finding the next article', () => {
    expect(cursorWherePickLeft(node('INPUT', { entry: true }), body, countLine)).toBe(false)
  })

  it('invoice and order lines: in the next blank line\'s search, or another line', () => {
    expect(cursorWherePickLeft(node('INPUT'), body, docLine)).toBe(false)
  })

  for (const [form, onLine] of FORMS) {
    it(`${form}: in another field of the form`, () => {
      expect(cursorWherePickLeft(node('INPUT'), body, onLine)).toBe(false)
      expect(cursorWherePickLeft(node('BUTTON'), body, onLine)).toBe(false)
    })

    it(`${form}: in an overlay that is open (a select's list, another dialog), even over the line`, () => {
      expect(cursorWherePickLeft(node('DIV', { overlay: 'open' }), body, onLine)).toBe(false)
      expect(cursorWherePickLeft(node('INPUT', { overlay: 'open', entry: true, pickRow: true }), body, onLine)).toBe(false)
    })
  }
})
