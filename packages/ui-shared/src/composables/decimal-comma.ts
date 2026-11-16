/**
 * A comma typed into a number field is a decimal separator (owner, 2026-11-12), on every machine.
 *
 * An `<input type="number">` reads what is typed in the number format of the MACHINE, not of the interface language:
 * Chromium on Windows follows the regional format, Chromium on Linux its own locale. Where that format writes decimals
 * with a comma (a Bulgarian regional format; checked on an en-AT one), „2,5" is two and a half already. Where it writes
 * them with a point (the Linux runner of the nightly e2e, in every locale), the comma is dropped as it is typed: „2,5"
 * becomes 25, and nothing on the screen says so. The nightly of 2026-11-13 typed 2,5 into an invoice line and the line
 * sold 25 (#734). `parseTyped` cannot help a number field: the comma is gone before the field's `input` event.
 *
 * So, once per page load and before the app mounts, `installDecimalComma` asks the browser how a hidden number field
 * reads „1,5". If the comma counts already, nothing changes. If it does not, or the question could not be asked, a comma
 * typed or pasted into a number field becomes a point: on `beforeinput`, before the browser filters it, through
 * `execCommand('insertText')`, the path a keystroke takes, so the field's `input` event follows and Undo still works.
 *
 * ⚠ Never convert where the comma already counts. There the point is the GROUPING separator, so „2." does not parse: the
 *   field reads EMPTY between the comma and the next digit (a line's quantity, and the price lookups that follow it,
 *   would run for nothing), and a trailing „2," would stay empty.
 *
 * `window.__LGR_DECIMAL_COMMA__` tells a spec or a support session which way a page went. Import-pure until installed;
 * `unit/decimal-comma.test.ts` holds the rules.
 */

export type DecimalCommaMode = 'native' | 'converted'

declare global {
  interface Window {
    /** How this page reads a comma in a number field: the browser's own way, or turned into a point. Set once. */
    __LGR_DECIMAL_COMMA__?: DecimalCommaMode
  }
}

/**
 * What goes into a number field whose value is `current`, instead of the inserted `text`: a point for its comma, `''`
 * for nothing at all, or `undefined` to leave the insertion to the browser.
 */
export function commaAsPoint(text: string | null | undefined, current: string): string | undefined {
  if (!text || !text.includes(',')) return undefined
  const t = text.trim()
  // A typed comma. A second separator goes in as nothing, as the browser drops it: a second point would leave nothing
  // the field can read.
  if (t === ',') return current.includes('.') ? '' : '.'
  // Text that arrives at once (a paste, a phone's keyboard) with ONE comma and no point: „2,5", „-0,75", „,5". Anything
  // else, such as „1,234.5", is the browser's to read.
  if (/^[-+]?\d*,\d+$/.test(t)) return t.replace(',', '.')
  return undefined
}

/** The part of a `beforeinput` event this reads, so a test can hand it a plain object. */
export interface BeforeInputLike {
  target: unknown
  inputType: string
  data: string | null
  isComposing?: boolean
  cancelable: boolean
  preventDefault(): void
}

/** The part of a `Document` an insertion needs. */
export interface EditableDocument {
  execCommand(commandId: string, showUI?: boolean, value?: string): boolean
}

function numberField(target: unknown): { value: string } | null {
  const el = target as { tagName?: unknown; type?: unknown; value?: unknown } | null
  return el?.tagName === 'INPUT' && el.type === 'number' && typeof el.value === 'string' ? { value: el.value } : null
}

/**
 * One `beforeinput` on a page that converts: when it would put a comma into a number field, what `commaAsPoint` says
 * goes in instead. True when it replaced the insertion.
 */
export function numberFieldBeforeInput(e: BeforeInputLike, doc: EditableDocument): boolean {
  if (!e.cancelable || e.isComposing) return false
  // In an <input> a paste carries its text in `data` too; `dataTransfer` is for an editable region (Input Events §3).
  if (e.inputType !== 'insertText' && e.inputType !== 'insertFromPaste') return false
  const field = numberField(e.target)
  if (!field) return false
  const replacement = commaAsPoint(e.data, field.value)
  if (replacement === undefined) return false
  e.preventDefault()
  if (replacement) doc.execCommand('insertText', false, replacement)
  return true
}

interface ProbeField {
  type: string
  tabIndex: number
  value: string
  style: { cssText: string }
  setAttribute(name: string, value: string): void
  focus(options?: { preventScroll?: boolean }): void
  remove(): void
}

/** The part of a `Document` the question needs. */
export interface ProbingDocument extends EditableDocument {
  body: { appendChild(node: never): unknown } | null
  activeElement: unknown
  createElement(tagName: 'input'): ProbeField
}

/**
 * Whether this browser's number fields read „1,5" as one and a half: true or false, or null when it could not be asked.
 * The text goes into a hidden number field through the editing path a keystroke takes, and the focus goes back.
 */
export function numberFieldsReadComma(doc: ProbingDocument): boolean | null {
  const body = doc.body
  if (!body || typeof doc.execCommand !== 'function') return null
  const probe = doc.createElement('input')
  probe.type = 'number'
  probe.tabIndex = -1
  probe.setAttribute('inputmode', 'none') // no on-screen keyboard on a tablet
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = 'position:fixed;top:0;left:-10000px;width:1px;height:1px;opacity:0;pointer-events:none'
  const before = doc.activeElement as { focus?: (options?: { preventScroll?: boolean }) => void } | null
  body.appendChild(probe as never)
  try {
    probe.focus({ preventScroll: true })
    if (doc.activeElement !== probe || !doc.execCommand('insertText', false, '1,5')) return null
    if (probe.value === '1.5') return true
    // „15": the comma was dropped as a grouping separator. „": the field kept „1,5" and cannot read it.
    return probe.value === '15' || probe.value === '' ? false : null
  } catch {
    return null
  } finally {
    probe.remove()
    if (before && before !== body && typeof before.focus === 'function') before.focus({ preventScroll: true })
  }
}

/** The part of a `Document` installing needs. */
export type InstallDocument = ProbingDocument & {
  defaultView: { __LGR_DECIMAL_COMMA__?: DecimalCommaMode } | null
  addEventListener(type: 'beforeinput', listener: (e: InputEvent) => void, capture: boolean): void
}

/**
 * Once per page, before the app mounts: where number fields drop a comma, a comma typed or pasted into one becomes a
 * point. Returns the way the page went; nothing without a document (a server, a test).
 */
export function installDecimalComma(doc?: InstallDocument): DecimalCommaMode | undefined {
  const target = doc ?? (typeof document === 'undefined' ? undefined : (document as unknown as InstallDocument))
  const win = target?.defaultView
  if (!target || !win) return undefined
  if (win.__LGR_DECIMAL_COMMA__) return win.__LGR_DECIMAL_COMMA__
  if (numberFieldsReadComma(target) === true) return (win.__LGR_DECIMAL_COMMA__ = 'native')
  // A null lands here too: a point is a decimal in every number format, and a dropped comma is a figure ten times off.
  target.addEventListener('beforeinput', e => { numberFieldBeforeInput(e, target) }, true)
  return (win.__LGR_DECIMAL_COMMA__ = 'converted')
}
