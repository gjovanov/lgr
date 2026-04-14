export class DalError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'DalError'
  }
}

export class NotFoundError extends DalError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

export class DuplicateError extends DalError {
  public readonly fields: Record<string, string>
  /**
   * Accepts either a single field/value pair or a map of fields (for compound unique indices).
   * Example: new DuplicateError('Invoice', { orgId: '...', invoiceNumber: 'INV-2026-00010' })
   */
  constructor(entity: string, fieldOrFields: string | Record<string, any>, value?: string) {
    const fields: Record<string, string> =
      typeof fieldOrFields === 'string'
        ? { [fieldOrFields]: String(value ?? 'unknown') }
        : Object.fromEntries(Object.entries(fieldOrFields).map(([k, v]) => [k, String(v)]))
    const parts = Object.entries(fields).map(([f, v]) => `${f}=${v}`).join(', ')
    super(`${entity} with ${parts} already exists`, 'DUPLICATE')
    this.name = 'DuplicateError'
    this.fields = fields
  }
}

export class ValidationError extends DalError {
  constructor(message: string) {
    super(message, 'VALIDATION')
    this.name = 'ValidationError'
  }
}
