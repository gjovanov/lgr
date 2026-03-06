import type { BaseEntity } from 'dal'
import { Types } from 'mongoose'

/**
 * Converts Mongoose documents to DAL entities and vice versa.
 * Handles _id ↔ id and ObjectId ↔ string conversions.
 */

/** List of fields that are ObjectId references (not exhaustive — covers common patterns) */
const ID_FIELD_SUFFIXES = ['Id', 'By']

function isObjectId(value: any): boolean {
  return value instanceof Types.ObjectId || (typeof value === 'object' && value?._bsontype === 'ObjectID')
}

/** Recursively convert ObjectId values to strings */
function convertIds(obj: any): any {
  if (obj == null) return obj
  if (isObjectId(obj)) return String(obj)
  if (obj instanceof Date) return obj
  if (Array.isArray(obj)) return obj.map(convertIds)
  if (typeof obj === 'object') {
    const result: any = {}
    for (const [key, value] of Object.entries(obj)) {
      if (key === '_id' || key === '__v') continue
      result[key] = convertIds(value)
    }
    return result
  }
  return obj
}

/** Convert a Mongoose lean document to a DAL entity */
export function toEntity<T extends BaseEntity>(doc: any): T {
  if (!doc) return doc
  const { _id, __v, ...rest } = typeof doc.toObject === 'function' ? doc.toObject() : doc
  const converted = convertIds(rest)
  return { id: String(_id), _id: String(_id), ...converted } as T
}

/** Convert a DAL entity (partial) to Mongoose document format */
export function toDocument(entity: any): any {
  if (!entity) return entity
  const { id, ...rest } = entity
  return convertToObjectIds(rest)
}

/** Recursively convert string IDs back to ObjectId where field names suggest they are references */
function convertToObjectIds(obj: any): any {
  if (obj == null) return obj
  if (isObjectId(obj)) return obj // pass through existing ObjectIds
  if (obj instanceof Date) return obj
  if (Array.isArray(obj)) return obj.map(convertToObjectIds)
  if (typeof obj === 'object') {
    const result: any = {}
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && isIdField(key) && Types.ObjectId.isValid(value)) {
        result[key] = new Types.ObjectId(value)
      } else {
        result[key] = convertToObjectIds(value)
      }
    }
    return result
  }
  return obj
}

function isIdField(key: string): boolean {
  return key === 'orgId' || key === 'ownerId' || ID_FIELD_SUFFIXES.some(suffix => key.endsWith(suffix))
}
