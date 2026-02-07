import type { IProduct, IStockLevel, IWarehouse } from 'db/models'
import { createWorkbook, finalizeWorkbook, styleHeaderRow, formatCurrency } from './base.excel.js'

export async function generateProductCatalogXLSX(products: IProduct[]): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Product Catalog')

  worksheet.columns = [
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Barcode', key: 'barcode', width: 18 },
    { header: 'Name', key: 'name', width: 35 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Unit', key: 'unit', width: 10 },
    { header: 'Purchase Price', key: 'purchasePrice', width: 16 },
    { header: 'Selling Price', key: 'sellingPrice', width: 16 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Tax Rate %', key: 'taxRate', width: 12 },
    { header: 'Track Inventory', key: 'trackInventory', width: 16 },
    { header: 'Active', key: 'isActive', width: 10 },
  ]

  styleHeaderRow(worksheet, 12)

  for (const product of products) {
    worksheet.addRow({
      sku: product.sku,
      barcode: product.barcode || '',
      name: product.name,
      category: product.category,
      type: product.type,
      unit: product.unit,
      purchasePrice: formatCurrency(product.purchasePrice),
      sellingPrice: formatCurrency(product.sellingPrice),
      currency: product.currency,
      taxRate: product.taxRate,
      trackInventory: product.trackInventory ? 'Yes' : 'No',
      isActive: product.isActive ? 'Yes' : 'No',
    }).commit()
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

export async function generateStockLevelsXLSX(
  stockLevels: IStockLevel[],
  products: IProduct[],
  warehouses: IWarehouse[],
): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Stock Levels')

  const productMap = new Map(products.map(p => [String(p._id), p]))
  const warehouseMap = new Map(warehouses.map(w => [String(w._id), w]))

  worksheet.columns = [
    { header: 'Product SKU', key: 'sku', width: 18 },
    { header: 'Product Name', key: 'productName', width: 35 },
    { header: 'Warehouse', key: 'warehouse', width: 25 },
    { header: 'Quantity', key: 'quantity', width: 14 },
    { header: 'Reserved', key: 'reserved', width: 14 },
    { header: 'Available', key: 'available', width: 14 },
    { header: 'Avg Cost', key: 'avgCost', width: 16 },
    { header: 'Last Count', key: 'lastCountDate', width: 14 },
  ]

  styleHeaderRow(worksheet, 8)

  for (const level of stockLevels) {
    const product = productMap.get(String(level.productId))
    const warehouse = warehouseMap.get(String(level.warehouseId))

    worksheet.addRow({
      sku: product?.sku || String(level.productId),
      productName: product?.name || '',
      warehouse: warehouse?.name || String(level.warehouseId),
      quantity: level.quantity,
      reserved: level.reservedQuantity,
      available: level.availableQuantity,
      avgCost: formatCurrency(level.avgCost),
      lastCountDate: level.lastCountDate ? level.lastCountDate.toISOString().split('T')[0] : '',
    }).commit()
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

export async function generateStockValuationXLSX(
  stockLevels: IStockLevel[],
  products: IProduct[],
): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Stock Valuation')

  const productMap = new Map(products.map(p => [String(p._id), p]))

  worksheet.columns = [
    { header: 'Product SKU', key: 'sku', width: 18 },
    { header: 'Product Name', key: 'productName', width: 35 },
    { header: 'Total Quantity', key: 'quantity', width: 16 },
    { header: 'Avg Cost', key: 'avgCost', width: 16 },
    { header: 'Total Value', key: 'totalValue', width: 18 },
    { header: 'Selling Price', key: 'sellingPrice', width: 16 },
    { header: 'Potential Revenue', key: 'potentialRevenue', width: 18 },
  ]

  styleHeaderRow(worksheet, 7)

  // Aggregate stock levels by product
  const productAggregates = new Map<string, { quantity: number; totalValue: number }>()
  for (const level of stockLevels) {
    const key = String(level.productId)
    const existing = productAggregates.get(key) || { quantity: 0, totalValue: 0 }
    existing.quantity += level.quantity
    existing.totalValue += level.quantity * level.avgCost
    productAggregates.set(key, existing)
  }

  let grandTotalValue = 0
  let grandTotalRevenue = 0

  for (const [productId, agg] of productAggregates) {
    const product = productMap.get(productId)
    const avgCost = agg.quantity > 0 ? agg.totalValue / agg.quantity : 0
    const potentialRevenue = agg.quantity * (product?.sellingPrice || 0)

    grandTotalValue += agg.totalValue
    grandTotalRevenue += potentialRevenue

    worksheet.addRow({
      sku: product?.sku || productId,
      productName: product?.name || '',
      quantity: agg.quantity,
      avgCost: formatCurrency(avgCost),
      totalValue: formatCurrency(agg.totalValue),
      sellingPrice: product ? formatCurrency(product.sellingPrice) : '',
      potentialRevenue: formatCurrency(potentialRevenue),
    }).commit()
  }

  // Totals row
  const totalsRow = worksheet.addRow({
    sku: '',
    productName: 'TOTALS',
    quantity: '',
    avgCost: '',
    totalValue: formatCurrency(grandTotalValue),
    sellingPrice: '',
    potentialRevenue: formatCurrency(grandTotalRevenue),
  })
  totalsRow.font = { bold: true }
  totalsRow.commit()

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
