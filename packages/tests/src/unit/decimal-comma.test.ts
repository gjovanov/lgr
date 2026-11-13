import { describe, it, expect } from 'bun:test'
import {
  commaAsPoint,
  installDecimalComma,
  numberFieldBeforeInput,
  numberFieldsReadComma,
  type BeforeInputLike,
  type InstallDocument,
} from 'ui-shared/composables/decimal-comma'

/**
 * Owner, 2026-11-12: a decimal is typed with a point or a comma. A number field reads what is typed in the MACHINE's
 * number format: Chromium on Linux drops a comma in every locale (the 2026-11-13 nightly typed „2,5" into an invoice
 * line and sold 25), while a machine whose format writes decimals with a comma reads it already, and there a point is
 * the grouping separator, so turning the comma into one would leave the field empty until the next digit. Hence: ask
 * the browser once, and convert only where the comma is dropped. The browser half is `e2e/tests/invoicing-crud.spec.ts`.
 */

describe('commaAsPoint: what goes into a number field instead of a comma', () => {
  it('a typed comma is a point, and a second separator is nothing', () => {
    expect(commaAsPoint(',', '')).toBe('.')
    expect(commaAsPoint(',', '2')).toBe('.')
    expect(commaAsPoint(',', '2.5')).toBe('')
    expect(commaAsPoint(' , ', '2')).toBe('.')
  })

  it('text that arrives at once with one comma and no point: the comma becomes a point', () => {
    expect(commaAsPoint('2,5', '')).toBe('2.5')
    expect(commaAsPoint('-0,75', '')).toBe('-0.75')
    expect(commaAsPoint('+3,5', '')).toBe('+3.5')
    expect(commaAsPoint(',5', '')).toBe('.5')
    expect(commaAsPoint(' 2,5 ', '')).toBe('2.5')
  })

  it('anything else is the browser to read: grouped figures, two commas, a trailing comma, no comma at all', () => {
    for (const text of ['1,234.5', '1,2,3', '2,', 'a,b', '2.5', '5', '', null, undefined]) {
      expect(commaAsPoint(text, '')).toBeUndefined()
    }
  })
})

const numberField = (value = '') => ({ tagName: 'INPUT', type: 'number', value })

function beforeInput(over: Partial<BeforeInputLike> = {}) {
  const e = {
    target: numberField() as unknown,
    inputType: 'insertText',
    data: ',' as string | null,
    isComposing: false,
    cancelable: true,
    prevented: false,
    preventDefault() { e.prevented = true },
    ...over,
  }
  return e
}

function editable() {
  const inserted: string[] = []
  return {
    inserted,
    execCommand(commandId: string, _showUI?: boolean, value?: string) {
      if (commandId === 'insertText') inserted.push(value ?? '')
      return true
    },
  }
}

describe('numberFieldBeforeInput: a page that converts', () => {
  it('a typed comma goes in as a point; into a field that has its point already, as nothing', () => {
    const doc = editable()
    const first = beforeInput({ target: numberField('2') })
    expect(numberFieldBeforeInput(first, doc)).toBe(true)
    expect(first.prevented).toBe(true)
    const second = beforeInput({ target: numberField('2.5') })
    expect(numberFieldBeforeInput(second, doc)).toBe(true)
    expect(second.prevented).toBe(true)
    expect(doc.inserted).toEqual(['.'])
  })

  it('a paste, and text from a keyboard that sends it at once, carry their text in data', () => {
    const doc = editable()
    expect(numberFieldBeforeInput(beforeInput({ inputType: 'insertFromPaste', data: '2,5' }), doc)).toBe(true)
    expect(numberFieldBeforeInput(beforeInput({ data: '1,5' }), doc)).toBe(true)
    expect(doc.inserted).toEqual(['2.5', '1.5'])
  })

  it('leaves alone: other fields, other insertions, compositions, and what the browser reads by itself', () => {
    const doc = editable()
    const untouched = [
      beforeInput({ target: { tagName: 'INPUT', type: 'text', value: '' } }),
      beforeInput({ target: { tagName: 'TEXTAREA', type: 'textarea', value: '' } }),
      beforeInput({ target: null }),
      beforeInput({ data: '5' }),
      beforeInput({ data: '.' }),
      beforeInput({ inputType: 'insertFromPaste', data: '1,234.5' }),
      beforeInput({ inputType: 'deleteContentBackward', data: null }),
      beforeInput({ inputType: 'insertCompositionText' }),
      beforeInput({ isComposing: true }),
      beforeInput({ inputType: 'insertFromDrop', data: '2,5' }),
      beforeInput({ cancelable: false }),
    ]
    for (const e of untouched) {
      expect(numberFieldBeforeInput(e, doc)).toBe(false)
      expect(e.prevented).toBe(false)
    }
    expect(doc.inserted).toEqual([])
  })
})

/**
 * A stand-in for a browser's document: `reads` is what its number field holds after „1,5" goes in through the editing
 * path, the way the browsers this was checked on answer (Windows with a comma format: 1.5; Linux: 15).
 */
function fakeDocument(reads: string, opts: { focusFails?: boolean; execFails?: boolean; execThrows?: boolean; noBody?: boolean } = {}) {
  const listeners: Array<{ type: string; capture: boolean; listener: (e: any) => void }> = []
  const appended: any[] = []
  let execCalls = 0
  const doc: any = {
    activeElement: null as any,
    defaultView: {} as { __LGR_DECIMAL_COMMA__?: string },
    body: opts.noBody ? null : { appendChild(node: any) { appended.push(node) } },
    createElement() {
      const el: any = {
        type: '', tabIndex: 0, value: '', style: { cssText: '' }, attrs: {} as Record<string, string>, removed: false,
        setAttribute(name: string, value: string) { el.attrs[name] = value },
        focus() { if (!opts.focusFails) doc.activeElement = el },
        remove() { el.removed = true },
      }
      return el
    },
    execCommand(_commandId: string, _showUI?: boolean, value?: string) {
      execCalls++
      if (opts.execThrows) throw new Error('not here')
      if (opts.execFails) return false
      doc.activeElement.value = value === '1,5' ? reads : doc.activeElement.value + value
      return true
    },
    addEventListener(type: string, listener: (e: any) => void, capture: boolean) { listeners.push({ type, listener, capture }) },
  }
  return { doc, listeners, appended, execCalls: () => execCalls }
}

describe('numberFieldsReadComma: asking the browser once', () => {
  it('true where „1,5" is one and a half, false where the comma is dropped or unreadable, null for anything else', () => {
    expect(numberFieldsReadComma(fakeDocument('1.5').doc)).toBe(true)
    expect(numberFieldsReadComma(fakeDocument('15').doc)).toBe(false)
    expect(numberFieldsReadComma(fakeDocument('').doc)).toBe(false)
    expect(numberFieldsReadComma(fakeDocument('1').doc)).toBeNull()
  })

  it('null when it cannot ask: no body, the focus does not land, the command fails or throws', () => {
    expect(numberFieldsReadComma(fakeDocument('1.5', { noBody: true }).doc)).toBeNull()
    expect(numberFieldsReadComma(fakeDocument('1.5', { focusFails: true }).doc)).toBeNull()
    expect(numberFieldsReadComma(fakeDocument('1.5', { execFails: true }).doc)).toBeNull()
    expect(numberFieldsReadComma(fakeDocument('1.5', { execThrows: true }).doc)).toBeNull()
  })

  it('the hidden field is a number field nobody can reach, it is removed, and the focus goes back', () => {
    const { doc, appended } = fakeDocument('15')
    let refocused = 0
    const before = { focus() { refocused++; doc.activeElement = before } }
    doc.activeElement = before
    numberFieldsReadComma(doc)
    const probe = appended[0]
    expect(probe.type).toBe('number')
    expect(probe.tabIndex).toBe(-1)
    expect(probe.attrs).toEqual({ inputmode: 'none', 'aria-hidden': 'true' })
    expect(probe.style.cssText).toContain('left:-10000px')
    expect(probe.removed).toBe(true)
    expect(refocused).toBe(1)
    expect(doc.activeElement).toBe(before)

    const failing = fakeDocument('1.5', { execThrows: true })
    numberFieldsReadComma(failing.doc)
    expect(failing.appended[0].removed).toBe(true)
  })
})

describe('installDecimalComma: once per page, converting only where the comma is dropped', () => {
  it('a browser that reads the comma is left alone', () => {
    const { doc, listeners } = fakeDocument('1.5')
    expect(installDecimalComma(doc as InstallDocument)).toBe('native')
    expect(listeners).toEqual([])
    expect(doc.defaultView.__LGR_DECIMAL_COMMA__).toBe('native')
  })

  it('a browser that drops it converts, in the capture phase, by the rules above', () => {
    const { doc, listeners } = fakeDocument('15')
    expect(installDecimalComma(doc as InstallDocument)).toBe('converted')
    expect(listeners.map(l => [l.type, l.capture])).toEqual([['beforeinput', true]])

    const typed = beforeInput({ target: numberField('2') })
    const inserted: string[] = []
    doc.execCommand = (_c: string, _u?: boolean, value?: string) => { inserted.push(value ?? ''); return true }
    listeners[0].listener(typed)
    expect(typed.prevented).toBe(true)
    expect(inserted).toEqual(['.'])
  })

  it('when the browser cannot be asked it converts too: a dropped comma is a figure ten times off', () => {
    const { doc, listeners } = fakeDocument('1.5', { execFails: true })
    expect(installDecimalComma(doc as InstallDocument)).toBe('converted')
    expect(listeners).toHaveLength(1)
  })

  it('asks once: a second install returns the first answer without asking again', () => {
    const native = fakeDocument('1.5')
    installDecimalComma(native.doc as InstallDocument)
    expect(installDecimalComma(native.doc as InstallDocument)).toBe('native')
    expect(native.execCalls()).toBe(1)

    const converted = fakeDocument('15')
    installDecimalComma(converted.doc as InstallDocument)
    expect(installDecimalComma(converted.doc as InstallDocument)).toBe('converted')
    expect(converted.listeners).toHaveLength(1)
  })

  it('without a document (a server, a test) it does nothing', () => {
    expect(installDecimalComma()).toBeUndefined()
  })
})
