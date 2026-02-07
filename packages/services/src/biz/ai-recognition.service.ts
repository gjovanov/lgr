import { File as FileModel } from 'db/models'
import { config } from 'config'
import { logger } from '../logger/logger.js'

interface RecognitionResult {
  type: string
  date?: string
  amount?: number
  currency?: string
  vendor?: string
  customer?: string
  invoiceNumber?: string
  lineItems?: {
    description: string
    quantity: number
    unitPrice: number
    total: number
  }[]
  taxInfo?: {
    taxId?: string
    taxRate?: number
    taxAmount?: number
  }
  confidence: number
}

export async function recognizeDocument(fileId: string): Promise<RecognitionResult> {
  const file = await FileModel.findById(fileId)
  if (!file) throw new Error('File not found')

  if (!config.anthropic.apiKey) {
    throw new Error('Anthropic API key not configured')
  }

  file.aiRecognition = { status: 'processing' }
  await file.save()

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: config.anthropic.apiKey })

    // Read file content
    const fileContent = await Bun.file(file.storagePath).arrayBuffer()
    const base64 = Buffer.from(fileContent).toString('base64')

    const mediaType = file.mimeType.startsWith('image/')
      ? file.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      : 'image/png'

    const isImage = file.mimeType.startsWith('image/')
    const isPdf = file.mimeType === 'application/pdf'

    const content: any[] = []

    if (isImage) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64 },
      })
    } else if (isPdf) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      })
    }

    content.push({
      type: 'text',
      text: `Extract structured accounting data from this document. Return a JSON object with these fields:
{
  "type": "invoice|receipt|bank_statement|contract|payslip|other",
  "date": "YYYY-MM-DD",
  "amount": number,
  "currency": "XXX",
  "vendor": "company name if purchase",
  "customer": "company name if sale",
  "invoiceNumber": "document reference number",
  "lineItems": [{ "description": "...", "quantity": 1, "unitPrice": 100, "total": 100 }],
  "taxInfo": { "taxId": "...", "taxRate": 18, "taxAmount": 0 },
  "confidence": 0.0-1.0
}
Only return the JSON, no other text.`,
    })

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('Failed to parse AI response')

    const result: RecognitionResult = JSON.parse(jsonMatch[0])

    file.aiRecognition = {
      status: 'completed',
      extractedData: result,
      confidence: result.confidence,
      processedAt: new Date(),
    }
    await file.save()

    logger.info({ fileId, type: result.type, confidence: result.confidence }, 'Document recognized')
    return result
  } catch (err: any) {
    file.aiRecognition = { status: 'failed' }
    await file.save()
    logger.error({ fileId, error: err.message }, 'Document recognition failed')
    throw err
  }
}
