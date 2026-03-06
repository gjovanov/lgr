import type { Filter, FilterOperator } from 'dal'
import { Types } from 'mongoose'

/**
 * Translates DAL Filter<T> to Mongoose FilterQuery.
 * Handles operator conversion and ObjectId coercion for ID fields.
 */
export function translateFilter(filter: Filter<any>): Record<string, any> {
  const result: Record<string, any> = {}

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue

    // Handle $or logical operator
    if (key === '$or' && Array.isArray(value)) {
      result.$or = value.map(subFilter => translateFilter(subFilter))
      continue
    }

    // Map DAL 'id' field to MongoDB '_id'
    const mongoKey = key === 'id' ? '_id' : key

    if (isFilterOperator(value)) {
      result[mongoKey] = translateOperator(mongoKey, value as FilterOperator<any>)
    } else if (isIdField(mongoKey) && typeof value === 'string' && Types.ObjectId.isValid(value)) {
      result[mongoKey] = new Types.ObjectId(value)
    } else {
      result[mongoKey] = value
    }
  }

  return result
}

function isFilterOperator(value: any): boolean {
  if (typeof value !== 'object' || value === null || value instanceof Date || Array.isArray(value)) return false
  return Object.keys(value).some(k => k.startsWith('$'))
}

function translateOperator(key: string, op: FilterOperator<any>): Record<string, any> {
  const result: Record<string, any> = {}

  if (op.$eq !== undefined) result.$eq = coerceId(key, op.$eq)
  if (op.$ne !== undefined) result.$ne = coerceId(key, op.$ne)
  if (op.$gt !== undefined) result.$gt = op.$gt
  if (op.$gte !== undefined) result.$gte = op.$gte
  if (op.$lt !== undefined) result.$lt = op.$lt
  if (op.$lte !== undefined) result.$lte = op.$lte
  if (op.$in !== undefined) result.$in = op.$in.map(v => coerceId(key, v))
  if (op.$nin !== undefined) result.$nin = op.$nin.map(v => coerceId(key, v))
  if (op.$regex !== undefined) result.$regex = op.$regex
  if (op.$exists !== undefined) result.$exists = op.$exists
  if (op.$text !== undefined) result.$text = op.$text

  return result
}

function coerceId(key: string, value: any): any {
  if (isIdField(key) && typeof value === 'string' && Types.ObjectId.isValid(value)) {
    return new Types.ObjectId(value)
  }
  return value
}

const ID_SUFFIXES = ['Id', 'By']

function isIdField(key: string): boolean {
  if (key === 'orgId' || key === 'ownerId' || key === '_id') return true
  // Handle dot-notation paths like 'lines.productId'
  const lastPart = key.includes('.') ? key.split('.').pop()! : key
  return ID_SUFFIXES.some(suffix => lastPart.endsWith(suffix))
}
