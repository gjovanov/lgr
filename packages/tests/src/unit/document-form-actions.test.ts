import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { collapseRanks, collapsedAt } from '../../../ui-shared/src/components/form-action-collapse'
import { COLLAPSE, IMPORT_KEY, withOutputActions } from '../../../web/src/modules/invoicing/composables/document-form/form-actions'
import en from '../../../ui-shared/src/locales/en.json'
import bg from '../../../ui-shared/src/locales/bg.json'
import de from '../../../ui-shared/src/locales/de.json'
import mk from '../../../ui-shared/src/locales/mk.json'

/**
 * Owner, 2026-11-15: an issued sales invoice had Save at its foot and not under its title, and e-mail and
 * print sat in a third row inside the document. "Btns should be consistent from header and bottom."
 *
 * A document form now has ONE list of actions, which `EntityFormShell` draws twice. These tests hold the two
 * things that keep it one list: the pure rules (where the output actions go, whose label a narrow bar gives up
 * first), and the shape of the sources — a second, hand-written row of buttons is how the bars came apart.
 */

const PACKAGES = resolve(import.meta.dir, '../../..')
const read = (rel: string) => readFileSync(join(PACKAGES, rel), 'utf8').replace(/\r\n/g, '\n')
/** A single-file component's template, without its script and style. */
const templateOf = (source: string) => source.slice(0, source.indexOf('\n<script'))

describe('where the output actions go', () => {
  const step = (key: string) => ({ key })

  it('after the document\'s own steps, in front of Import', () => {
    const bar = withOutputActions([step('issue-print'), step('issue'), step('save'), step(IMPORT_KEY)], [step('email'), step('print')])
    expect(bar.map((a) => a.key)).toEqual(['issue-print', 'issue', 'save', 'email', 'print', IMPORT_KEY])
  })

  it('at the end of a bar that offers no Import (an issued sales invoice)', () => {
    const bar = withOutputActions([step('save'), step('payment')], [step('email'), step('print')])
    expect(bar.map((a) => a.key)).toEqual(['save', 'payment', 'email', 'print'])
  })

  it('an output the document does not offer now is left out: no e-mail of a bill, no receipt before one is booked', () => {
    const bar = withOutputActions([step('receive'), step('save'), step(IMPORT_KEY)], [null, step('print'), undefined])
    expect(bar.map((a) => a.key)).toEqual(['receive', 'save', 'print', IMPORT_KEY])
  })

  it('the steps are neither reordered nor changed', () => {
    const steps = [step('convert-invoice'), step('save'), step(IMPORT_KEY)]
    const bar = withOutputActions(steps, [step('print')])
    expect(steps.map((a) => a.key)).toEqual(['convert-invoice', 'save', IMPORT_KEY])
    expect(bar[0]).toBe(steps[0])
  })
})

describe('whose label a narrow bar gives up first', () => {
  it('the action used least first; print keeps its word the longest', () => {
    const order = Object.entries(COLLAPSE).sort((a, b) => a[1] - b[1]).map(([name]) => name)
    expect(order).toEqual(['import', 'followUp', 'debitNote', 'creditNote', 'stockReceipt', 'email', 'print'])
    expect(new Set(Object.values(COLLAPSE)).size).toBe(Object.keys(COLLAPSE).length)
  })

  const actions = [
    { key: 'save' },
    { key: 'payment', icon: 'mdi-cash' },
    { key: 'debit', icon: 'mdi-file-plus-outline', collapse: COLLAPSE.debitNote },
    { key: 'email', icon: 'mdi-email', collapse: COLLAPSE.email },
    { key: 'print', icon: 'mdi-printer', collapse: COLLAPSE.print },
    { key: 'import', icon: 'mdi-file-upload-outline', collapse: COLLAPSE.import },
  ]
  const shownAsIcons = (level: number) => {
    const ranks = collapseRanks(actions)
    return actions.filter((a) => collapsedAt(a, ranks, level)).map((a) => a.key)
  }

  it('only the ranks the bar holds count, lowest first', () => {
    expect(collapseRanks(actions)).toEqual([COLLAPSE.import, COLLAPSE.debitNote, COLLAPSE.email, COLLAPSE.print])
  })

  it('one rank at a time, and nothing while there is room', () => {
    expect(shownAsIcons(0)).toEqual([])
    expect(shownAsIcons(1)).toEqual(['import'])
    expect(shownAsIcons(2)).toEqual(['debit', 'import'])
    expect(shownAsIcons(4)).toEqual(['debit', 'email', 'print', 'import'])
  })

  it('an action with no rank keeps its label however narrow the bar: save, a payment', () => {
    expect(shownAsIcons(99)).not.toContain('save')
    expect(shownAsIcons(99)).not.toContain('payment')
  })

  it('an action with no icon keeps its label whatever rank it names: nothing would be left to show', () => {
    const noIcon = [{ key: 'a', collapse: 1 }, { key: 'b', icon: 'mdi-x', collapse: 2 }]
    expect(collapseRanks(noIcon)).toEqual([2])
    expect(collapsedAt(noIcon[0], collapseRanks(noIcon), 5)).toBe(false)
    expect(collapsedAt(noIcon[1], collapseRanks(noIcon), 1)).toBe(true)
  })

  it('actions that share a rank give up their labels together', () => {
    const quote = [{ key: 'to-invoice', icon: 'i', collapse: COLLAPSE.followUp }, { key: 'to-proforma', icon: 'i', collapse: COLLAPSE.followUp }]
    const ranks = collapseRanks(quote)
    expect(ranks).toEqual([COLLAPSE.followUp])
    expect(quote.map((a) => collapsedAt(a, ranks, 1))).toEqual([true, true])
  })
})

describe('one list feeds both bars', () => {
  const shell = read('ui-shared/src/components/EntityFormShell.vue')
  const form = read('web/src/modules/invoicing/components/document-form/DocumentForm.vue')
  const composable = read('web/src/modules/invoicing/composables/document-form/useDocumentForm.ts')

  it('the shell draws the bar under the title and the one at the foot from the same list', () => {
    const template = templateOf(shell)
    const rows = template.match(/<FormActionBar[\s\S]*?\/>/g) ?? []
    expect(rows.length).toBe(2)
    for (const row of rows) expect(row).toContain(':actions="visibleActions"')
    // The second row is findable on its own, and is not the bar the specs call `.form-actions-bar`.
    expect(rows[1]).toContain('test-id-suffix="-bottom"')
    expect(rows[1]).not.toContain('form-actions-bar')
  })

  it('the document form hands the shell one list, and asks for it at the foot too', () => {
    const template = templateOf(form)
    expect(template).toContain(':actions="barActions"')
    expect(template).toMatch(/<EntityFormShell[\s\S]*?\n {4}bottom-actions\n/)
    expect(form).toContain('withOutputActions(formActions.value, [emailAction.value, printAction.value, stockReceiptAction.value])')
  })

  it('and writes no button of its own for what the bars offer', () => {
    const template = templateOf(form)
    for (const handler of ['onSave', 'doc.onPrint', 'doc.onPrintOptions', 'openEmailDialog', 'onPrintStockReceipt', 'doc.onSaveAndReceive', 'doc.onIssueAndPrint']) {
      expect({ handler, clicked: template.includes(`@click="${handler}"`) }).toEqual({ handler, clicked: false })
    }
    for (const testId of ['print-now', 'print-options', 'print-stock-receipt']) {
      expect({ testId, inTemplate: template.includes(`data-testid="${testId}"`) }).toEqual({ testId, inTemplate: false })
    }
  })

  it('every action of the form names a key: the bars are compared, and found, by it', () => {
    const literals = composable.match(/\{ key: [^\n]*handler:[^\n]*\}/g) ?? []
    expect(literals.length).toBeGreaterThanOrEqual(6)
    // The actions built over several lines name theirs on a line of their own.
    for (const key of ["key: IMPORT_KEY,", "key: 'print',", "key: 'stock-receipt',", "key: `convert-${target}`,"]) {
      expect({ key, found: composable.includes(key) }).toEqual({ key, found: true })
    }
    expect(form).toContain("key: 'email',")
  })

  it('Save is offered once a document is issued, in whichever bar: no status takes it away', () => {
    expect(composable).toContain("const savesIssued = config.docType !== 'cash_sale'")
    expect(composable).toContain('if (savesIssued) issued.push(issued.length ? outlinedSave : save)')
    // The gate that used to hide it under the title only now decides Import alone.
    expect((composable.match(/config\.editSaveGate/g) ?? []).length).toBe(1)
    expect(composable).toContain("if (config.editSaveGate !== 'draft-only') issued.push(importAction)")
  })
})

describe('„Издай и печатай" asks how to print before it issues', () => {
  const composable = read('web/src/modules/invoicing/composables/document-form/useDocumentForm.ts')
  const between = (from: string, to: string) => {
    const a = composable.indexOf(from)
    const b = composable.indexOf(to, a)
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    return composable.slice(a, b)
  }

  it('the button opens the Print dialog, and nothing is saved or issued by opening it', () => {
    expect(composable).toMatch(/key: 'issue-print',[^\n]*handler: onIssueAndPrint,/)
    const body = between('async function onIssueAndPrint()', 'async function onPrintDialogConfirm')
    expect(body).toContain("printDialogFor.value = 'issue'")
    expect(body).toContain('showExportDialog.value = true')
    for (const call of ['issueFromForm(', 'saveIfNeeded(', 'persist(', 'onExportSingle(', 'httpClient.']) {
      expect({ call, made: body.includes(call) }).toEqual({ call, made: false })
    }
  })

  it('its confirmation issues, and the print that follows is the one the dialog chose', () => {
    const confirm = between('async function onPrintDialogConfirm', 'const printAction')
    expect(confirm).toContain('await issueFromForm(o)')
    const issue = between('async function issueFromForm(print: PrintChoice | null)', 'function openNote')
    expect(issue).toContain('if (print) await onExportSingle(print)')
    // Not the last settings: those are for the one-click „Печат".
    expect(issue).not.toContain('lastPrint')
  })

  it('plain „Печат" stays one click with the last settings, and „Издай" issues without a dialog', () => {
    const print = between('async function onPrint()', 'const printDialogFor')
    expect(print).toContain('await onExportSingle({ ...lastPrint.value, companions: [] })')
    expect(print).not.toContain('showExportDialog')
    expect(composable).toMatch(/key: 'issue',[^\n]*handler: \(\) => issueFromForm\(null\),/)
  })
})

describe('„Складова разписка" asks which price to print before it prints', () => {
  const composable = read('web/src/modules/invoicing/composables/document-form/useDocumentForm.ts')
  const form = read('web/src/modules/invoicing/components/document-form/DocumentForm.vue')
  const dialog = read('web/src/modules/invoicing/components/StockReceiptPrintDialog.vue')
  const between = (source: string, from: string, to: string) => {
    const a = source.indexOf(from)
    const b = source.indexOf(to, a)
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    return source.slice(a, b)
  }

  it('the action opens the dialog, and nothing is rendered or downloaded by opening it', () => {
    expect(composable).toMatch(/key: 'stock-receipt',[\s\S]{0,400}?handler: onPrintStockReceipt,/)
    const body = between(composable, 'function onPrintStockReceipt()', 'async function printStockReceipt(')
    expect(body).toContain('stockReceiptDialog.value = true')
    for (const call of ['exportStockReceipt(', 'httpClient.', 'await ']) {
      expect({ call, made: body.includes(call) }).toEqual({ call, made: false })
    }
  })

  it('the dialog\'s „Печат" prints at the level it chose, then closes it; a refusal leaves it open', () => {
    const body = between(composable, 'async function printStockReceipt(priceLevel: string)', 'const stockReceiptAction')
    expect(body).toContain("'stock_receipt', undefined, { priceLevel })")
    const printed = body.indexOf('await exportStockReceipt(')
    const closed = body.indexOf('stockReceiptDialog.value = false')
    const refused = body.indexOf('} catch')
    expect(printed).toBeGreaterThan(-1)
    expect(closed).toBeGreaterThan(printed)
    expect(refused).toBeGreaterThan(closed)
    expect(body.slice(refused)).not.toContain('stockReceiptDialog')
  })

  it('the form mounts it once, and it is the dialog that prints', () => {
    const tags = templateOf(form).match(/<StockReceiptPrintDialog\b[^>]*\/>/g) ?? []
    expect(tags).toHaveLength(1)
    expect(tags[0]).toContain('v-model="stockReceiptDialog"')
    expect(tags[0]).toContain(':loading="stockReceiptLoading"')
    expect(tags[0]).toContain('@confirm="printStockReceipt"')
  })

  it('Cancel only closes; the choice is remembered when it is printed, never before', () => {
    const template = templateOf(dialog)
    expect(template).toMatch(/data-testid="stock-receipt-cancel" @click="open = false"/)
    expect(template).toMatch(/data-testid="stock-receipt-confirm"\s+@click="confirm"/)
    const confirm = between(dialog, 'function confirm()', '</script>')
    expect(confirm.indexOf('rememberPriceLevel(level.value)')).toBeGreaterThan(-1)
    expect(confirm.indexOf("emit('confirm', level.value)")).toBeGreaterThan(confirm.indexOf('rememberPriceLevel(level.value)'))
    expect((dialog.match(/rememberPriceLevel\(/g) ?? []).length).toBe(1)
  })

  it('it reads the levels and the last choice again every time it opens, from the one list the route checks', () => {
    const opened = between(dialog, 'watch(open,', 'function focusPrint')
    expect(opened).toContain('accessGrant()')
    expect(opened).toContain('priceLevelItems(grant,')
    expect(opened).toContain('level.value = startingPriceLevel(grant)')
    const levels = read('web/src/modules/invoicing/composables/stock-receipt-price.ts')
    expect(levels).toContain("from 'config/stock-receipt-price'")
    // Per user and org, through the session: never a key of its own.
    expect(levels).toContain("rememberedSetting<string>('stock-receipt-price')")
    expect(levels).not.toMatch(/localStorage|sessionStorage/)
  })
})

describe('the Print dialog of a document keeps its columns folded', () => {
  function* vueFiles(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) yield* vueFiles(path)
      else if (name.endsWith('.vue')) yield path
    }
  }
  const dialogs: { file: string; tag: string }[] = []
  const roots = [join(PACKAGES, 'web', 'src', 'modules'), ...readdirSync(PACKAGES).filter((p) => p.endsWith('-ui')).map((p) => join(PACKAGES, p, 'src'))]
  for (const root of roots) {
    for (const file of vueFiles(root)) {
      const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      for (const tag of source.match(/<ExportDialog\b[\s\S]*?\/>/g) ?? []) dialogs.push({ file: relative(PACKAGES, file).replace(/\\/g, '/'), tag })
    }
  }
  const isPrint = (tag: string) => tag.includes(`:title="$t('common.print')"`)

  it('every dialog that prints one document asks for it', () => {
    const prints = dialogs.filter((d) => isPrint(d.tag))
    expect(prints.map((d) => d.file).sort()).toEqual([
      'web/src/modules/invoicing/components/document-form/CashSaleTerminal.vue',
      'web/src/modules/invoicing/components/document-form/DocumentForm.vue',
    ])
    for (const d of prints) expect({ file: d.file, folded: /\n\s+collapsible-columns\n/.test(d.tag) }).toEqual({ file: d.file, folded: true })
  })

  it('a list\'s export dialog shows its columns as it always did', () => {
    const lists = dialogs.filter((d) => !isPrint(d.tag))
    expect(lists.length).toBeGreaterThanOrEqual(5)
    for (const d of lists) expect({ file: d.file, folded: d.tag.includes('collapsible-columns') }).toEqual({ file: d.file, folded: false })
  })

  it('folded on every open, with the count of chosen columns in its header', () => {
    const dialog = read('ui-shared/src/components/ExportDialog.vue')
    expect(dialog).toContain('const columnsOpen = ref(!props.collapsibleColumns)')
    // Inside the watcher that runs when the dialog opens.
    const opened = dialog.slice(dialog.indexOf('watch(() => props.modelValue'), dialog.indexOf('watch(mode, resetSelection)'))
    expect(opened).toContain('columnsOpen.value = !props.collapsibleColumns')
    const template = templateOf(dialog)
    expect(template).toContain(`$t('common.itemsSelected', { n: selectedColumns.length })`)
    expect(template).toContain(':aria-expanded="columnsOpen ? \'true\' : \'false\'"')
  })
})

describe('the words the bars and the dialog reuse, in four locales', () => {
  const KEYS = [
    'common.save', 'common.print', 'common.cancel', 'common.download', 'common.expand', 'common.collapse', 'common.itemsSelected',
    'export.columns', 'export.companionDocs', 'export.companionDocsHint',
    'invoicing.issueFlow.issueAndPrint', 'invoicing.issueFlow.printOptions',
    'invoicing.sendEmail.action', 'invoicing.sendEmail.draftBlocked', 'invoicing.sendEmail.lastSent',
    'invoicing.stockReceipt.print', 'invoicing.stockReceipt.hint', 'invoicing.stockReceipt.price', 'invoicing.stockReceipt.booked',
    'warehouse.sellingPrice',
    'docImport.importFile',
  ]
  const at = (cat: any, key: string) => key.split('.').reduce((o, k) => o?.[k], cat)

  it('each is a string in every locale: a missing key would show as its own name', () => {
    for (const [loc, cat] of Object.entries({ en, bg, de, mk })) {
      for (const key of KEYS) expect({ loc, key, type: typeof at(cat, key) }).toEqual({ loc, key, type: 'string' })
    }
  })

  it('the count of chosen columns takes its number', () => {
    for (const [loc, cat] of Object.entries({ en, bg, de, mk })) {
      expect({ loc, counts: String(at(cat, 'common.itemsSelected')).includes('{n}') }).toEqual({ loc, counts: true })
    }
  })
})
