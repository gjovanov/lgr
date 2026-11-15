import type { Page } from '@playwright/test'

/**
 * What a browser's translator does to a page, without the translating: every text node that holds words is
 * REPLACED by an element of the translator's own (Chrome's is `<font><font>…</font></font>`). The words stay
 * the same here, so the page still reads as it did; what changes is that the nodes the app made are gone from
 * the document, which is the whole of the harm.
 *
 * Returns how many nodes it replaced.
 */
export async function translatePage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const nodes: Node[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    let replaced = 0
    for (const text of nodes) {
      const parent = text.parentNode
      if (!parent || !text.nodeValue || !text.nodeValue.trim()) continue
      if (['SCRIPT', 'STYLE', 'TEXTAREA', 'FONT'].includes(parent.nodeName)) continue
      const outer = document.createElement('font')
      const inner = document.createElement('font')
      inner.textContent = text.nodeValue
      outer.appendChild(inner)
      parent.replaceChild(outer, text)
      replaced++
    }
    return replaced
  })
}
