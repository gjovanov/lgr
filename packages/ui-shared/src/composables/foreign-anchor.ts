/**
 * A page whose nodes something else has replaced must not take the app down.
 *
 * Vue keeps every node it made and puts a new one BEFORE one of them (`parent.insertBefore(el, anchor)`).
 * A browser's translator replaces the page's text nodes with its own, and so do a good many extensions.
 * The node the app was going to insert before is then no child of anything; the browser refuses
 * (`NotFoundError: … the node before which the new node is to be inserted is not a child of this node`),
 * Vue stops half way through the change, and the half-made tree cannot be taken down again: every later
 * move away from the page throws, so its Back button does nothing. Found 2026-11-15 on a bill whose status
 * chip gained its tick (an icon placed before the chip's text) after the page had been translated.
 *
 * `index.html` asks translators to leave the page alone, and the page says which language it is in
 * (`plugins/i18n#declareLanguage`), so a browser has no reason to translate it. This is for whatever does
 * not ask: an insert whose anchor is gone goes at the END of its parent. On a page being rewritten under
 * the app the new node may then sit a word away from its place; the app keeps working, and can be left.
 *
 * ⚠ Only that one case changes. An anchor that is a child, and no anchor at all, are the browser's own
 * insert, untouched. The first one a page meets is said in the console, so that a page someone else is
 * rewriting can be told from a bug of ours (a list with a key twice ends here too).
 */

/** What is patched: an element's `insertBefore`. A fake with the same method stands in for it in the tests. */
export interface AnchorHost {
  insertBefore(node: any, anchor: any): any
}

/** The node an insert names as its place. */
interface Placed {
  parentNode: unknown
}

const TOLERANT = Symbol.for('lgr.tolerant-insert')

function sayOnce(): (anchor: unknown, parent: unknown) => void {
  let said = false
  return (anchor, parent) => {
    if (said) return
    said = true
    console.warn(
      '[lgr] Something outside the app changed this page (a translator or a browser extension): a node the app placed is gone, and what belonged before it was put at the end of its parent instead.',
      { anchor, parent },
    )
  }
}

/**
 * Make `insertBefore` put a node at the end of its parent when the anchor it names is not that parent's
 * child. Once per prototype; `undefined` where there is no DOM.
 */
export function tolerateForeignAnchors(
  host: AnchorHost | undefined = typeof Node === 'undefined' ? undefined : (Node.prototype as AnchorHost),
  report: (anchor: unknown, parent: unknown) => void = sayOnce(),
): 'installed' | 'already' | undefined {
  if (!host) return undefined
  const native = host.insertBefore
  if ((native as any)[TOLERANT]) return 'already'
  const tolerant = function (this: unknown, node: unknown, anchor: Placed | null | undefined) {
    if (anchor && anchor.parentNode !== this) {
      report(anchor, this)
      return native.call(this, node, null)
    }
    return native.call(this, node, anchor)
  }
  ;(tolerant as any)[TOLERANT] = true
  host.insertBefore = tolerant
  return 'installed'
}
