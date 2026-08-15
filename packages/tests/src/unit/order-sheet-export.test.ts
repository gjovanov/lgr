import { describe, it, expect } from 'bun:test'
import ExcelJS from 'exceljs'
import { generateOrderSheetXLSX } from 'reporting/excel/order-sheet.excel'
import type { OrderSheetCtx } from 'reporting/order-sheet.i18n'

function fixtureCtx(): OrderSheetCtx {
  const group = {
    _id: 'g1',
    supplierId: 'sup1',
    reference: 'REF-77',
    lines: [
      {
        productId: 'p1',
        description: 'ВИНТ М4Х70 - DIN 963',
        sku: 'RPZ-00001',
        quantity: 1000,
        unit: 'pcs',
        expectedUnitPrice: 0.05,
        allocations: [
          { _id: 'a1', warehouseId: 'wh1', quantity: 700, receivedQuantity: 0 },
          { _id: 'a2', warehouseId: 'wh2', quantity: 300, receivedQuantity: 0 },
        ],
      },
    ],
  }
  return {
    order: { orderNumber: 'ORD-2026-00001', issueDate: new Date('2026-07-26'), notes: 'бележка' },
    group,
    org: { name: 'РЕГАЛ ООД', taxNumber: '112500982' },
    supplierName: 'Fastbolt GmbH',
    supplierTaxId: 'DE123456',
    productInfo: { p1: { name: 'ВИНТ М4Х70 - DIN 963', sku: 'RPZ-00001', unit: 'pcs' } },
    warehouseNames: { wh1: 'Склад Пазарджик', wh2: 'Склад София' },
    contactNames: { sup1: 'Fastbolt GmbH', c1: 'Клиент Едно', c2: 'Клиент Две', c3: 'Клиент Три' },
    // RES- docs grouped by allocationId (first-class reservations).
    reservations: {
      a1: [
        { contactId: 'c1', quantity: 300 },
        { contactId: 'c2', quantity: 200 },
      ],
      a2: [{ contactId: 'c3', quantity: 100 }],
    },
    locale: 'bg',
  }
}

async function allCellText(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as any)
  const chunks: string[] = []
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      row.eachCell((cell) => chunks.push(String(cell.value ?? '')))
    })
  })
  return chunks.join(' | ')
}

describe('Order sheet exports', () => {
  it('supplier variant redacts warehouses and client reservations', async () => {
    const buffer = await generateOrderSheetXLSX(fixtureCtx(), 'supplier')
    expect(buffer.length).toBeGreaterThan(0)
    const text = await allCellText(buffer)
    expect(text).toContain('ORD-2026-00001')
    expect(text).toContain('ВИНТ М4Х70 - DIN 963')
    expect(text).toContain('Fastbolt GmbH')
    // Internal split must NOT leak to the supplier.
    expect(text).not.toContain('Клиент Едно')
    expect(text).not.toContain('Клиент Две')
    expect(text).not.toContain('Склад Пазарджик')
  })

  it('internal variant contains the full WH/client breakdown', async () => {
    const buffer = await generateOrderSheetXLSX(fixtureCtx(), 'internal')
    const text = await allCellText(buffer)
    expect(text).toContain('Склад Пазарджик')
    expect(text).toContain('Склад София')
    expect(text).toContain('Клиент Едно')
    expect(text).toContain('Клиент Три')
    // Free remainder for WH1: 700 − (300+200) = 200.
    expect(text).toContain('200')
  })
})
