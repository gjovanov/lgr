import type { IDeal, IPipeline, IActivity } from 'db/models'
import { createWorkbook, finalizeWorkbook, styleHeaderRow, formatCurrency, formatDate } from './base.excel.js'

export async function generatePipelineReportXLSX(deals: IDeal[], pipeline: IPipeline): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Pipeline Report')

  // Title
  worksheet.addRow([`Pipeline: ${pipeline.name}`]).commit()
  worksheet.addRow([]).commit()

  worksheet.columns = [
    { header: 'Deal Name', key: 'name', width: 30 },
    { header: 'Stage', key: 'stage', width: 18 },
    { header: 'Contact', key: 'contactId', width: 25 },
    { header: 'Value', key: 'value', width: 16 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Probability %', key: 'probability', width: 14 },
    { header: 'Expected Close', key: 'expectedCloseDate', width: 16 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Assigned To', key: 'assignedTo', width: 20 },
  ]

  const headerRow = worksheet.getRow(3)
  headerRow.values = ['Deal Name', 'Stage', 'Contact', 'Value', 'Currency', 'Probability %', 'Expected Close', 'Status', 'Assigned To']
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } }
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' }
  headerRow.commit()

  let totalValue = 0
  let weightedValue = 0

  for (const deal of deals) {
    totalValue += deal.value
    weightedValue += deal.value * (deal.probability / 100)

    worksheet.addRow({
      name: deal.name,
      stage: deal.stage,
      contactId: String(deal.contactId),
      value: formatCurrency(deal.value),
      currency: deal.currency,
      probability: deal.probability,
      expectedCloseDate: deal.expectedCloseDate ? formatDate(deal.expectedCloseDate) : '',
      status: deal.status,
      assignedTo: String(deal.assignedTo),
    }).commit()
  }

  // Summary rows
  worksheet.addRow([]).commit()
  const summaryRow1 = worksheet.addRow({ name: 'Total Pipeline Value', value: formatCurrency(totalValue) })
  summaryRow1.font = { bold: true }
  summaryRow1.commit()

  const summaryRow2 = worksheet.addRow({ name: 'Weighted Pipeline Value', value: formatCurrency(weightedValue) })
  summaryRow2.font = { bold: true }
  summaryRow2.commit()

  const summaryRow3 = worksheet.addRow({ name: 'Total Deals', value: String(deals.length) })
  summaryRow3.font = { bold: true }
  summaryRow3.commit()

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

export async function generateActivityReportXLSX(activities: IActivity[]): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Activity Report')

  worksheet.columns = [
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Subject', key: 'subject', width: 35 },
    { header: 'Description', key: 'description', width: 40 },
    { header: 'Priority', key: 'priority', width: 12 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Assigned To', key: 'assignedTo', width: 20 },
    { header: 'Due Date', key: 'dueDate', width: 14 },
    { header: 'Completed', key: 'completedAt', width: 14 },
    { header: 'Duration (min)', key: 'duration', width: 14 },
    { header: 'Outcome', key: 'outcome', width: 30 },
  ]

  styleHeaderRow(worksheet, 10)

  for (const activity of activities) {
    worksheet.addRow({
      type: activity.type,
      subject: activity.subject,
      description: activity.description || '',
      priority: activity.priority,
      status: activity.status,
      assignedTo: String(activity.assignedTo),
      dueDate: activity.dueDate ? formatDate(activity.dueDate) : '',
      completedAt: activity.completedAt ? formatDate(activity.completedAt) : '',
      duration: activity.duration || '',
      outcome: activity.outcome || '',
    }).commit()
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
