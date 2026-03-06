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
  constructor(entity: string, field: string, value: string) {
    super(`${entity} with ${field}=${value} already exists`, 'DUPLICATE')
    this.name = 'DuplicateError'
  }
}

export class ValidationError extends DalError {
  constructor(message: string) {
    super(message, 'VALIDATION')
    this.name = 'ValidationError'
  }
}
