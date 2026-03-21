/**
 * SUPTO Appendix 29 Export Tables (18.1–18.9) — Excel/XLSX generator.
 *
 * Each function produces a single worksheet in XLSX format matching
 * the column specification from Appendix 29 of Ordinance Н-18.
 */

import { createWorkbook, finalizeWorkbook, styleHeaderRow, formatCurrency, formatDate } from './base.excel.js'

// ── 18.1 Summarized Sales ──

export async function generateTable181(transactions: any[], cashSales: any[]): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const ws = workbook.addWorksheet('18.1 Summarized Sales')

  ws.columns = [
    { header: 'УНП', key: 'unpNumber', width: 26 },
    { header: 'Transaction #', key: 'transactionNumber', width: 20 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Date/Time', key: 'dateTime', width: 20 },
    { header: 'Operator Code', key: 'operatorCode', width: 14 },
    { header: 'Fiscal Device #', key: 'fiscalDeviceNumber', width: 16 },
    { header: 'Fiscal Receipt #', key: 'fiscalReceiptNumber', width: 16 },
    { header: 'Subtotal', key: 'subtotal', width: 14 },
    { header: 'Discount', key: 'discountTotal', width: 12 },
    { header: 'VAT', key: 'taxTotal', width: 12 },
    { header: 'Total', key: 'total', width: 14 },
    { header: 'Customer', key: 'customer', width: 20 },
  ]
  styleHeaderRow(ws, 13)

  for (const t of transactions) {
    ws.addRow({
      unpNumber: t.unpNumber || '',
      transactionNumber: t.transactionNumber,
      type: t.type,
      status: t.status,
      dateTime: t.createdAt ? formatDate(new Date(t.createdAt)) : '',
      operatorCode: t.fiscalDeviceNumber ? '' : '', // derived from UNP
      fiscalDeviceNumber: t.fiscalDeviceNumber || '',
      fiscalReceiptNumber: t.fiscalReceiptNumber || '',
      subtotal: formatCurrency(t.subtotal),
      discountTotal: formatCurrency(t.discountTotal || 0),
      taxTotal: formatCurrency(t.taxTotal || 0),
      total: formatCurrency(t.total),
      customer: t.customerId || '',
    }).commit()
  }

  // Cash sales from invoicing
  for (const inv of cashSales) {
    ws.addRow({
      unpNumber: '',
      transactionNumber: inv.invoiceNumber,
      type: 'cash_sale',
      status: inv.status,
      dateTime: inv.issueDate ? formatDate(new Date(inv.issueDate)) : '',
      operatorCode: '',
      fiscalDeviceNumber: '',
      fiscalReceiptNumber: '',
      subtotal: formatCurrency(inv.subtotal),
      discountTotal: formatCurrency(inv.discountTotal || 0),
      taxTotal: formatCurrency(inv.taxTotal || 0),
      total: formatCurrency(inv.total),
      customer: inv.contactId || '',
    }).commit()
  }

  ws.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

// ── 18.2 Payment Details ──

export async function generateTable182(transactions: any[]): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const ws = workbook.addWorksheet('18.2 Payment Details')

  ws.columns = [
    { header: 'УНП', key: 'unpNumber', width: 26 },
    { header: 'Transaction #', key: 'transactionNumber', width: 20 },
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Total Amount', key: 'total', width: 14 },
    { header: 'Payment Method', key: 'method', width: 16 },
    { header: 'Payment Amount', key: 'amount', width: 14 },
    { header: 'Reference', key: 'reference', width: 20 },
    { header: 'Fiscal Device #', key: 'fiscalDeviceNumber', width: 16 },
  ]
  styleHeaderRow(ws, 8)

  for (const t of transactions) {
    for (const p of t.payments || []) {
      ws.addRow({
        unpNumber: t.unpNumber || '',
        transactionNumber: t.transactionNumber,
        date: t.createdAt ? formatDate(new Date(t.createdAt)) : '',
        total: formatCurrency(t.total),
        method: p.method,
        amount: formatCurrency(p.amount),
        reference: p.reference || '',
        fiscalDeviceNumber: t.fiscalDeviceNumber || '',
      }).commit()
    }
  }

  ws.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

// ── 18.3 Itemized Sales ──

export async function generateTable183(transactions: any[]): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const ws = workbook.addWorksheet('18.3 Itemized Sales')

  ws.columns = [
    { header: 'УНП', key: 'unpNumber', width: 26 },
    { header: 'Transaction #', key: 'transactionNumber', width: 20 },
    { header: 'Product ID', key: 'productId', width: 26 },
    { header: 'Product Name', key: 'name', width: 30 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Unit Price', key: 'unitPrice', width: 14 },
    { header: 'Discount %', key: 'discount', width: 12 },
    { header: 'Tax Rate %', key: 'taxRate', width: 12 },
    { header: 'Tax Amount', key: 'taxAmount', width: 12 },
    { header: 'Line Total', key: 'lineTotal', width: 14 },
  ]
  styleHeaderRow(ws, 10)

  for (const t of transactions) {
    for (const line of t.lines || []) {
      ws.addRow({
        unpNumber: t.unpNumber || '',
        transactionNumber: t.transactionNumber,
        productId: line.productId || '',
        name: line.name,
        quantity: line.quantity,
        unitPrice: formatCurrency(line.unitPrice),
        discount: line.discount || 0,
        taxRate: line.taxRate || 0,
        taxAmount: formatCurrency(line.taxAmount || 0),
        lineTotal: formatCurrency(line.lineTotal),
      }).commit()
    }
  }

  ws.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

// ── 18.4 Reversed (Storno) Sales ──

export async function generateTable184(stornoTransactions: any[]): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const ws = workbook.addWorksheet('18.4 Reversed Sales')

  ws.columns = [
    { header: 'Storno УНП', key: 'unpNumber', width: 26 },
    { header: 'Storno Transaction #', key: 'transactionNumber', width: 20 },
    { header: 'Original УНП', key: 'originalUNP', width: 26 },
    { header: 'Original Receipt #', key: 'originalFiscalReceiptNumber', width: 18 },
    { header: 'Original Date', key: 'originalDate', width: 14 },
    { header: 'Storno Reason', key: 'stornoReason', width: 20 },
    { header: 'Storno Date', key: 'stornoDate', width: 14 },
    { header: 'Fiscal Receipt #', key: 'fiscalReceiptNumber', width: 16 },
    { header: 'Total', key: 'total', width: 14 },
    { header: 'Product Name', key: 'productName', width: 30 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Unit Price', key: 'unitPrice', width: 14 },
  ]
  styleHeaderRow(ws, 12)

  for (const t of stornoTransactions) {
    for (const line of t.lines || []) {
      ws.addRow({
        unpNumber: t.unpNumber || '',
        transactionNumber: t.transactionNumber,
        originalUNP: t.originalUNP || '',
        originalFiscalReceiptNumber: t.originalFiscalReceiptNumber || '',
        originalDate: t.originalTransactionDate ? formatDate(new Date(t.originalTransactionDate)) : '',
        stornoReason: t.stornoReason || '',
        stornoDate: t.createdAt ? formatDate(new Date(t.createdAt)) : '',
        fiscalReceiptNumber: t.fiscalReceiptNumber || '',
        total: formatCurrency(t.total),
        productName: line.name,
        quantity: line.quantity,
        unitPrice: formatCurrency(line.unitPrice),
      }).commit()
    }
  }

  ws.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

// ── 18.5 Cancelled Sales ──

export async function generateTable185(cancelledTransactions: any[]): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const ws = workbook.addWorksheet('18.5 Cancelled Sales')

  ws.columns = [
    { header: 'УНП', key: 'unpNumber', width: 26 },
    { header: 'Transaction #', key: 'transactionNumber', width: 20 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Created Date', key: 'createdDate', width: 14 },
    { header: 'Cancelled Date', key: 'cancelledDate', width: 14 },
    { header: 'Total', key: 'total', width: 14 },
    { header: 'Product Name', key: 'productName', width: 30 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Unit Price', key: 'unitPrice', width: 14 },
  ]
  styleHeaderRow(ws, 9)

  for (const t of cancelledTransactions) {
    for (const line of t.lines || []) {
      ws.addRow({
        unpNumber: t.unpNumber || '',
        transactionNumber: t.transactionNumber,
        type: t.type,
        createdDate: t.createdAt ? formatDate(new Date(t.createdAt)) : '',
        cancelledDate: t.updatedAt ? formatDate(new Date(t.updatedAt)) : '',
        total: formatCurrency(t.total),
        productName: line.name,
        quantity: line.quantity,
        unitPrice: formatCurrency(line.unitPrice),
      }).commit()
    }
  }

  ws.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

// ── 18.6 Delivery Summary ──

export async function generateTable186(movements: any[], contactMap: Map<string, any>): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const ws = workbook.addWorksheet('18.6 Delivery Summary')

  ws.columns = [
    { header: 'Movement #', key: 'movementNumber', width: 20 },
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Supplier ID', key: 'supplierId', width: 26 },
    { header: 'Supplier Name', key: 'supplierName', width: 30 },
    { header: 'Invoice Ref', key: 'invoiceRef', width: 20 },
    { header: 'Total Amount', key: 'totalAmount', width: 14 },
    { header: 'Status', key: 'status', width: 12 },
  ]
  styleHeaderRow(ws, 7)

  for (const m of movements) {
    const contact = m.contactId ? contactMap.get(m.contactId) : null
    ws.addRow({
      movementNumber: m.movementNumber,
      date: m.date ? formatDate(new Date(m.date)) : '',
      supplierId: m.contactId || '',
      supplierName: contact?.companyName || contact?.firstName || '',
      invoiceRef: m.invoiceId || '',
      totalAmount: formatCurrency(m.totalAmount || 0),
      status: m.status,
    }).commit()
  }

  ws.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

// ── 18.7 Delivery Details ──

export async function generateTable187(movements: any[], productMap: Map<string, any>): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const ws = workbook.addWorksheet('18.7 Delivery Details')

  ws.columns = [
    { header: 'Movement #', key: 'movementNumber', width: 20 },
    { header: 'Product ID', key: 'productId', width: 26 },
    { header: 'Product Name', key: 'productName', width: 30 },
    { header: 'Quantity', key: 'quantity', width: 12 },
    { header: 'Unit Cost', key: 'unitCost', width: 14 },
    { header: 'Total Cost', key: 'totalCost', width: 14 },
  ]
  styleHeaderRow(ws, 6)

  for (const m of movements) {
    for (const line of m.lines || []) {
      const product = productMap.get(line.productId)
      ws.addRow({
        movementNumber: m.movementNumber,
        productId: line.productId,
        productName: product?.name || line.productId,
        quantity: line.quantity,
        unitCost: formatCurrency(line.unitCost || 0),
        totalCost: formatCurrency(line.totalCost || 0),
      }).commit()
    }
  }

  ws.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

// ── 18.8 Stock Movement Summary ──

export async function generateTable188(
  stockLevels: any[],
  movements: any[],
  productMap: Map<string, any>,
): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const ws = workbook.addWorksheet('18.8 Stock Movements')

  ws.columns = [
    { header: 'Product ID', key: 'productId', width: 26 },
    { header: 'Product Name', key: 'productName', width: 30 },
    { header: 'Current Qty', key: 'currentQty', width: 12 },
    { header: 'Current Value', key: 'currentValue', width: 14 },
    { header: 'Period Receipts (Qty)', key: 'receiptQty', width: 18 },
    { header: 'Period Receipts (Value)', key: 'receiptValue', width: 18 },
    { header: 'Period Dispatches (Qty)', key: 'dispatchQty', width: 18 },
    { header: 'Period Dispatches (Value)', key: 'dispatchValue', width: 20 },
  ]
  styleHeaderRow(ws, 8)

  // Aggregate movements by product
  const periodDebits = new Map<string, { qty: number; value: number }>()
  const periodCredits = new Map<string, { qty: number; value: number }>()

  for (const m of movements) {
    for (const line of m.lines || []) {
      const pid = line.productId
      if (['receipt', 'return', 'production_in'].includes(m.type)) {
        const cur = periodDebits.get(pid) || { qty: 0, value: 0 }
        cur.qty += line.quantity
        cur.value += line.totalCost || line.quantity * (line.unitCost || 0)
        periodDebits.set(pid, cur)
      }
      if (['dispatch', 'production_out'].includes(m.type)) {
        const cur = periodCredits.get(pid) || { qty: 0, value: 0 }
        cur.qty += line.quantity
        cur.value += line.totalCost || line.quantity * (line.unitCost || 0)
        periodCredits.set(pid, cur)
      }
    }
  }

  for (const sl of stockLevels) {
    const product = productMap.get(sl.productId)
    const debits = periodDebits.get(sl.productId) || { qty: 0, value: 0 }
    const credits = periodCredits.get(sl.productId) || { qty: 0, value: 0 }

    ws.addRow({
      productId: sl.productId,
      productName: product?.name || sl.productId,
      currentQty: sl.quantity,
      currentValue: formatCurrency(sl.quantity * (sl.avgCost || 0)),
      receiptQty: debits.qty,
      receiptValue: formatCurrency(debits.value),
      dispatchQty: credits.qty,
      dispatchValue: formatCurrency(credits.value),
    }).commit()
  }

  ws.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

// ── 18.9 Nomenclature Tables ──

export async function generateTable189(data: {
  products: any[]
  contacts: any[]
  warehouses: any[]
  users: any[]
  workstations: any[]
}): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()

  // Products sheet
  const wsProd = workbook.addWorksheet('Products')
  wsProd.columns = [
    { header: 'SKU', key: 'sku', width: 16 },
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Active', key: 'isActive', width: 8 },
    { header: 'Created', key: 'createdAt', width: 14 },
    { header: 'Modified', key: 'updatedAt', width: 14 },
    { header: 'Deactivated', key: 'deactivatedAt', width: 14 },
  ]
  styleHeaderRow(wsProd, 7)
  for (const p of data.products) {
    wsProd.addRow({
      sku: p.sku, name: p.name, type: p.type,
      isActive: p.isActive ? 'Yes' : 'No',
      createdAt: p.createdAt ? formatDate(new Date(p.createdAt)) : '',
      updatedAt: p.updatedAt ? formatDate(new Date(p.updatedAt)) : '',
      deactivatedAt: p.deactivatedAt ? formatDate(new Date(p.deactivatedAt)) : '',
    }).commit()
  }
  wsProd.commit()

  // Contacts sheet (Suppliers + Customers)
  const wsCont = workbook.addWorksheet('Contacts')
  wsCont.columns = [
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Company', key: 'companyName', width: 30 },
    { header: 'Tax ID', key: 'taxId', width: 18 },
    { header: 'VAT #', key: 'vatNumber', width: 18 },
    { header: 'Active', key: 'isActive', width: 8 },
    { header: 'Created', key: 'createdAt', width: 14 },
    { header: 'Modified', key: 'updatedAt', width: 14 },
    { header: 'Deactivated', key: 'deactivatedAt', width: 14 },
  ]
  styleHeaderRow(wsCont, 8)
  for (const c of data.contacts) {
    wsCont.addRow({
      type: c.type, companyName: c.companyName || `${c.firstName} ${c.lastName}`,
      taxId: c.taxId || '', vatNumber: c.vatNumber || '',
      isActive: c.isActive ? 'Yes' : 'No',
      createdAt: c.createdAt ? formatDate(new Date(c.createdAt)) : '',
      updatedAt: c.updatedAt ? formatDate(new Date(c.updatedAt)) : '',
      deactivatedAt: c.deactivatedAt ? formatDate(new Date(c.deactivatedAt)) : '',
    }).commit()
  }
  wsCont.commit()

  // Warehouses sheet
  const wsWh = workbook.addWorksheet('Warehouses')
  wsWh.columns = [
    { header: 'Code', key: 'code', width: 12 },
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Active', key: 'isActive', width: 8 },
    { header: 'Created', key: 'createdAt', width: 14 },
    { header: 'Modified', key: 'updatedAt', width: 14 },
    { header: 'Deactivated', key: 'deactivatedAt', width: 14 },
  ]
  styleHeaderRow(wsWh, 7)
  for (const w of data.warehouses) {
    wsWh.addRow({
      code: w.code, name: w.name, type: w.type,
      isActive: w.isActive ? 'Yes' : 'No',
      createdAt: w.createdAt ? formatDate(new Date(w.createdAt)) : '',
      updatedAt: w.updatedAt ? formatDate(new Date(w.updatedAt)) : '',
      deactivatedAt: w.deactivatedAt ? formatDate(new Date(w.deactivatedAt)) : '',
    }).commit()
  }
  wsWh.commit()

  // Operators sheet
  const wsOp = workbook.addWorksheet('Operators')
  wsOp.columns = [
    { header: 'Operator Code', key: 'operatorCode', width: 14 },
    { header: 'First Name', key: 'firstName', width: 18 },
    { header: 'Middle Name', key: 'middleName', width: 18 },
    { header: 'Last Name', key: 'lastName', width: 18 },
    { header: 'Position', key: 'position', width: 20 },
    { header: 'Role', key: 'role', width: 16 },
    { header: 'Active', key: 'isActive', width: 8 },
    { header: 'Created', key: 'createdAt', width: 14 },
    { header: 'Deactivated', key: 'deactivatedAt', width: 14 },
  ]
  styleHeaderRow(wsOp, 9)
  for (const u of data.users) {
    wsOp.addRow({
      operatorCode: u.operatorCode || '',
      firstName: u.firstName, middleName: u.middleName || '', lastName: u.lastName,
      position: u.position || '', role: u.role,
      isActive: u.isActive ? 'Yes' : 'No',
      createdAt: u.createdAt ? formatDate(new Date(u.createdAt)) : '',
      deactivatedAt: u.deactivatedAt ? formatDate(new Date(u.deactivatedAt)) : '',
    }).commit()
  }
  wsOp.commit()

  // Workstations sheet
  const wsWs = workbook.addWorksheet('Workstations')
  wsWs.columns = [
    { header: 'Code', key: 'code', width: 12 },
    { header: 'Name', key: 'name', width: 25 },
    { header: 'Warehouse', key: 'warehouseId', width: 26 },
    { header: 'Fiscal Device', key: 'fiscalDeviceId', width: 26 },
    { header: 'Active', key: 'isActive', width: 8 },
    { header: 'Created', key: 'createdAt', width: 14 },
    { header: 'Deactivated', key: 'deactivatedAt', width: 14 },
  ]
  styleHeaderRow(wsWs, 7)
  for (const ws2 of data.workstations) {
    wsWs.addRow({
      code: ws2.code, name: ws2.name,
      warehouseId: ws2.warehouseId || '', fiscalDeviceId: ws2.fiscalDeviceId || '',
      isActive: ws2.isActive ? 'Yes' : 'No',
      createdAt: ws2.createdAt ? formatDate(new Date(ws2.createdAt)) : '',
      deactivatedAt: ws2.deactivatedAt ? formatDate(new Date(ws2.deactivatedAt)) : '',
    }).commit()
  }
  wsWs.commit()

  return finalizeWorkbook(workbook, tmpFile)
}
