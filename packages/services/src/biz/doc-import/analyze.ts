/**
 * Orchestration: extracted text → `AnalyzedDoc[]`. **Persists nothing.**
 *
 * The same call serves both flows. The batch path shows the results in a review table and
 * then commits them; the single-document path takes `results[0].mapped` and diffs it
 * against an open form. Because analysis is side-effect-free (bar contact creation, which
 * is opt-in), a user can analyse a folder, look at what it would do, and walk away.
 */
import { detectDocKind, isMovementKind } from './detect.js'
import { findDuplicateCashSale, findDuplicateInvoice, findDuplicateMovement } from './dedupe.js'
import { mapInvoiceExtraction } from './map-invoice.js'
import { mapCashSaleExport } from './map-cash-sale.js'
import { mapMovementExtraction, mapStoreOperations } from './map-movement.js'
import { ocrDraft } from './ocr-client.js'
import type { ParsedSpreadsheet } from './xlsx.js'
import type { AnalyzedDoc, DocKind, DraftResult, ImportTarget, MappedInvoice } from './types.js'

export interface AnalyzeItem {
  fileId: string
  filename?: string
  /** OCR text (possibly hand-corrected in the review step). */
  text?: string
  /** Pre-parsed payload for spreadsheet sources, which never go through the model. */
  parsed?: any
  /** Force the sidecar's extraction profile instead of letting it auto-detect. */
  profile?: string
  /** Skip the sidecar entirely — used by tests and by re-analysis of an edited draft. */
  draft?: DraftResult
  /**
   * Authoritative kind hint (e.g. from a filename prefix) used ONLY as a fallback when text
   * detection is inconclusive. Content detection still wins so a "2000 КОРЕКЦИЯ" is caught —
   * this just rescues docs whose landscape layout fragments the title (`СТОКОВА … РАЗПИСКА`
   * split across columns) so `detectDocKind` returns `unknown`.
   */
  kind?: DocKind
}

export interface AnalyzeContext {
  warehouseId?: string
  orderId?: string
  contactId?: string
  movementType?: string
  date?: string
}

export interface AnalyzeOptions {
  /** Batch imports create unknown counterparties; the single-document flow offers a choice. */
  createMissingContact?: boolean
  batchId?: string
}

/** Which way a document must point to belong on this surface. */
export function expectedDirection(target: ImportTarget): 'outgoing' | 'incoming' | null {
  if (target === 'bill') return 'incoming'
  if (target === 'sales_invoice' || target === 'cash_sale') return 'outgoing'
  return null
}

/** The document type each surface creates. */
export function docTypeFor(target: ImportTarget): string {
  return target === 'cash_sale' ? 'cash_sale' : 'invoice'
}

/** Sidecar profile for a detected kind. */
export function profileForKind(kind: DocKind): string | undefined {
  if (kind === 'goods_receipt' || kind === 'correction') return 'goods_receipt'
  if (kind === 'transfer_note' || kind === 'issue_note') return 'stock_note'
  if (kind === 'invoice') return 'invoice'
  return undefined
}

/**
 * A day of cash-register takings. The business day is taken from the caller's context or,
 * failing that, from the filename (`salesAnalysis_20260804_...xlsx`) — never from "today",
 * which would silently key the wrong day.
 */
export function cashRegisterDate(filename: string | undefined, contextDate?: string): string | null {
  if (contextDate) return contextDate
  const m = /(\d{4})-?(\d{2})-?(\d{2})/.exec(filename || '')
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

async function analyzeCashRegister(
  orgId: string,
  item: AnalyzeItem,
  sheet: ParsedSpreadsheet,
  context: AnalyzeContext,
  base: AnalyzedDoc,
): Promise<AnalyzedDoc> {
  const date = cashRegisterDate(item.filename, context.date)
  if (!date) {
    return {
      ...base,
      docKind: 'cash_register',
      error: 'could not determine the business day — the filename carries no date, so set one explicitly',
    }
  }

  const { mapped, perLine, warnings } = await mapCashSaleExport(orgId, sheet.salesAnalysis!, {
    date,
    warehouseId: context.warehouseId,
  })
  const duplicate = await findDuplicateCashSale(orgId, mapped.reference || '')

  return {
    ...base,
    docKind: 'cash_register',
    direction: 'outgoing',
    duplicate: duplicate || undefined,
    mapped,
    diagnostics: { perLine, warnings },
  }
}

/** A стокова/складова разписка or искане → one (or two, for a correction) movements. */
async function analyzeStockDocument(
  orgId: string,
  item: AnalyzeItem,
  kind: DocKind,
  context: AnalyzeContext,
  base: AnalyzedDoc,
): Promise<AnalyzedDoc> {
  let draft: DraftResult
  try {
    draft = item.draft ?? (await ocrDraft(item.text || '', item.profile ?? profileForKind(kind)))
  } catch (e: any) {
    return { ...base, error: String(e?.message || e) }
  }

  const { movements, perLine, warnings } = await mapMovementExtraction(orgId, draft.extraction, kind, {
    filename: item.filename,
    warehouseId: context.warehouseId,
    movementType: context.movementType as any,
    date: context.date,
  })
  if (!movements.length) {
    return { ...base, validation: draft.validation, diagnostics: { perLine, warnings }, error: warnings[0] || 'nothing to import' }
  }

  const duplicate = await findDuplicateMovement(orgId, movements[0].marker)

  return {
    ...base,
    validation: draft.validation,
    duplicate: duplicate || undefined,
    // The first movement carries the document; a correction's negative half rides along.
    mapped: movements[0],
    extraMovements: movements.slice(1),
    diagnostics: { perLine, warnings },
  }
}

/** A `storeOperations` (Операция: Доставки) export → one receipt movement. */
async function analyzeStoreOperations(
  orgId: string,
  item: AnalyzeItem,
  sheet: ParsedSpreadsheet,
  context: AnalyzeContext,
  base: AnalyzedDoc,
): Promise<AnalyzedDoc> {
  const parsed = sheet.storeOperations!
  const date = context.date || parsed.periodStart || cashRegisterDate(item.filename)
  if (!date) {
    return {
      ...base,
      docKind: 'store_operations',
      error: 'could not determine the business day — the export carries no period and the filename no date',
    }
  }

  const { movements, perLine, warnings } = await mapStoreOperations(orgId, parsed, {
    filename: item.filename,
    date,
    warehouseId: context.warehouseId,
  })
  const duplicate = await findDuplicateMovement(orgId, movements[0].marker)

  return {
    ...base,
    docKind: 'store_operations',
    duplicate: duplicate || undefined,
    mapped: movements[0],
    diagnostics: { perLine, warnings },
  }
}

async function analyzeOne(
  orgId: string,
  target: ImportTarget,
  item: AnalyzeItem,
  context: AnalyzeContext,
  options: AnalyzeOptions,
): Promise<AnalyzedDoc> {
  const base: AnalyzedDoc = {
    fileId: item.fileId,
    filename: item.filename || '',
    docKind: 'unknown',
    diagnostics: { perLine: [], warnings: [] },
  }

  const rawText = item.text || ''

  // ── spreadsheet sources: deterministic layouts, no model involved ──
  const sheet = item.parsed as ParsedSpreadsheet | undefined
  if (sheet?.kind === 'salesAnalysis') {
    return analyzeCashRegister(orgId, item, sheet, context, base)
  }
  if (sheet?.kind === 'storeOperations') {
    return analyzeStoreOperations(orgId, item, sheet, context, base)
  }

  // Content detection wins (so a "2000 КОРЕКЦИЯ" upgrades goods_receipt→correction); the
  // filename-derived hint only rescues a doc whose fragmented landscape title defeats the regex.
  const detected = detectDocKind(rawText)
  const kind = detected !== 'unknown' ? detected : (item.kind ?? 'unknown')
  base.docKind = kind === 'unknown' && target !== 'movement' ? 'invoice' : kind

  if (isMovementKind(base.docKind)) {
    return analyzeStockDocument(orgId, item, base.docKind, context, base)
  }
  if (target === 'movement') {
    return {
      ...base,
      error: 'this does not look like a стокова/складова разписка or искане — the Movements page imports those',
    }
  }

  let draft: DraftResult
  try {
    draft = item.draft ?? (await ocrDraft(rawText, item.profile ?? profileForKind(base.docKind)))
  } catch (e: any) {
    return { ...base, error: String(e?.message || e) }
  }

  const type = docTypeFor(target)
  const result = await mapInvoiceExtraction(orgId, draft, rawText, {
    warehouseId: context.warehouseId,
    orderId: context.orderId,
    createMissingContact: options.createMissingContact !== false,
    batchId: options.batchId,
    type,
  })

  const mapped: MappedInvoice = result.mapped
  const warnings = [...result.warnings]

  // The direction is inferred from the org's ЕИК, never forced: a sales invoice dropped on
  // the Bills page is still a sales invoice, and turning it into a bill would invent data.
  // Flag it instead so the review step can exclude it.
  const expected = expectedDirection(target)
  if (expected && mapped.direction !== expected) {
    warnings.push(`document is ${mapped.direction}, this page imports ${expected} documents`)
  }
  if (result.uncertain) warnings.push('could not confirm the org identity in the text — direction is a guess')
  if (mapped.reference && item.filename && !item.filename.includes(mapped.reference)) {
    // The CLI skills' hardest-learned rule: a misread Номер would be preserved verbatim as
    // the issued number, so a filename/number disagreement must never auto-convert.
    const fileDigits = (item.filename.match(/\d{4,}/g) || [])
    if (fileDigits.length && !fileDigits.includes(mapped.reference)) {
      warnings.push(`document number ${mapped.reference} does not appear in the filename`)
    }
  }
  if (mapped.reference && rawText && !rawText.includes(mapped.reference)) {
    warnings.push(`document number ${mapped.reference} not found in the extracted text`)
  }

  const duplicate = target === 'cash_sale'
    ? await findDuplicateCashSale(orgId, mapped.reference || '')
    : await findDuplicateInvoice(orgId, mapped.reference || '', type, mapped.direction)

  return {
    ...base,
    direction: mapped.direction,
    uncertain: result.uncertain,
    validation: draft.validation,
    duplicate: duplicate || undefined,
    mapped,
    diagnostics: {
      perLine: result.perLine,
      contactSuggestion: result.contactSuggestion,
      warnings,
    },
  }
}

/**
 * Analyse a batch. Items are processed one at a time — the sidecar runs a model per
 * document on a single replica, so concurrency here buys nothing and only makes the
 * progress reporting lie.
 */
export async function analyzeDocuments(
  orgId: string,
  target: ImportTarget,
  items: AnalyzeItem[],
  context: AnalyzeContext = {},
  options: AnalyzeOptions = {},
  onProgress?: (done: number, total: number, label: string) => Promise<void> | void,
): Promise<AnalyzedDoc[]> {
  const out: AnalyzedDoc[] = []
  for (let i = 0; i < items.length; i++) {
    await onProgress?.(i, items.length, `Analyzing ${items[i].filename || items[i].fileId} (${i + 1}/${items.length})`)
    try {
      out.push(await analyzeOne(orgId, target, items[i], context, options))
    } catch (e: any) {
      out.push({
        fileId: items[i].fileId,
        filename: items[i].filename || '',
        docKind: 'unknown',
        diagnostics: { perLine: [], warnings: [] },
        error: String(e?.message || e),
      })
    }
  }

  // Two files carrying the same document number is a folder mistake (the same PDF twice,
  // or a duplicate export) — worth saying before either is committed.
  const byRef = new Map<string, number>()
  for (const d of out) {
    const ref = (d.mapped as MappedInvoice | undefined)?.reference
    if (ref) byRef.set(ref, (byRef.get(ref) || 0) + 1)
  }
  for (const d of out) {
    const ref = (d.mapped as MappedInvoice | undefined)?.reference
    if (ref && (byRef.get(ref) || 0) > 1) {
      d.diagnostics.warnings.push(`document number ${ref} appears on more than one file in this batch`)
    }
  }

  await onProgress?.(items.length, items.length, 'Analysis complete')
  return out
}
