import type { Database } from 'bun:sqlite'
import type { BaseEntity, Filter, SortSpec, PageRequest, PageResult, AggregateStage } from 'dal'
import type { IBatchRepository } from 'dal'
import { DuplicateError } from 'dal'
import { toRow, toEntity } from './entity-mapper.js'
import { translateFilter, toSnakeCase } from './filter-translator.js'

/**
 * SQLite implementation of IBatchRepository.
 * Uses bun:sqlite for all database operations.
 */
export class SQLiteRepository<T extends BaseEntity> implements IBatchRepository<T> {
  constructor(
    protected db: Database,
    protected tableName: string,
    protected childTables: ChildTableConfig[] = [],
  ) {}

  async findById(id: string): Promise<T | null> {
    const row = this.db.query(`SELECT * FROM ${this.tableName} WHERE id = ?`).get(id) as Record<string, any> | null
    if (!row) return null
    return this.hydrateEntity(row)
  }

  async findOne(filter: Filter<T>): Promise<T | null> {
    const { clause, params } = translateFilter(filter)
    const row = this.db.query(`SELECT * FROM ${this.tableName} WHERE ${clause} LIMIT 1`).get(...params) as Record<string, any> | null
    if (!row) return null
    return this.hydrateEntity(row)
  }

  async findAll(filter: Filter<T>, page?: PageRequest): Promise<PageResult<T>> {
    const { clause, params } = translateFilter(filter)
    const sort = page?.sort ?? { createdAt: -1 }
    const size = page?.size ?? 10
    const pageNum = page?.page ?? 0
    const orderBy = this.buildOrderBy(sort)

    if (size === 0) {
      const rows = this.db.query(`SELECT * FROM ${this.tableName} WHERE ${clause} ${orderBy}`).all(...params) as Record<string, any>[]
      const items = await Promise.all(rows.map(r => this.hydrateEntity(r)))
      return { items, total: items.length, page: 0, size: 0, totalPages: 1 }
    }

    const offset = pageNum * size
    const countResult = this.db.query(`SELECT COUNT(*) as cnt FROM ${this.tableName} WHERE ${clause}`).get(...params) as { cnt: number }
    const total = countResult.cnt

    const rows = this.db.query(
      `SELECT * FROM ${this.tableName} WHERE ${clause} ${orderBy} LIMIT ? OFFSET ?`,
    ).all(...params, size, offset) as Record<string, any>[]

    const items = await Promise.all(rows.map(r => this.hydrateEntity(r)))

    return {
      items,
      total,
      page: pageNum,
      size,
      totalPages: Math.ceil(total / size),
    }
  }

  async findMany(filter: Filter<T>, sort: SortSpec = { createdAt: -1 }): Promise<T[]> {
    const { clause, params } = translateFilter(filter)
    const orderBy = this.buildOrderBy(sort)
    const rows = this.db.query(`SELECT * FROM ${this.tableName} WHERE ${clause} ${orderBy}`).all(...params) as Record<string, any>[]
    return Promise.all(rows.map(r => this.hydrateEntity(r)))
  }

  async create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const fullData = { ...data, id, createdAt: new Date(now), updatedAt: new Date(now) }
    const row = toRow(fullData as any)

    try {
      const transaction = this.db.transaction(() => {
        // Extract child data before inserting parent
        const childData = this.extractChildData(row)

        const cols = Object.keys(row).filter(k => !this.isChildField(k))
        const vals = cols.map(c => row[c])
        const placeholders = cols.map(() => '?').join(', ')

        this.db.run(
          `INSERT INTO ${this.tableName} (${cols.join(', ')}) VALUES (${placeholders})`,
          vals,
        )

        // Insert child rows
        for (const child of this.childTables) {
          const items = childData[child.entityField] || []
          for (let i = 0; i < items.length; i++) {
            const childRow = toRow(items[i])
            if (!childRow.id) childRow.id = crypto.randomUUID()
            childRow[child.parentFk] = id
            if (!childRow.sort_order) childRow.sort_order = i

            const childCols = Object.keys(childRow)
            const childVals = childCols.map(c => childRow[c])
            const childPlaceholders = childCols.map(() => '?').join(', ')

            this.db.run(
              `INSERT INTO ${child.tableName} (${childCols.join(', ')}) VALUES (${childPlaceholders})`,
              childVals,
            )
          }
        }
      })

      transaction()
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint failed')) {
        const match = err.message.match(/UNIQUE constraint failed: (\w+)\.(\w+)/)
        throw new DuplicateError(this.tableName, match?.[2] || 'unknown', 'unknown')
      }
      throw err
    }

    return (await this.findById(id))!
  }

  async update(id: string, data: Partial<T>): Promise<T | null> {
    const existing = await this.findById(id)
    if (!existing) return null

    const now = new Date().toISOString()
    const row = toRow({ ...data, updatedAt: new Date(now) } as any)

    const transaction = this.db.transaction(() => {
      // Update parent fields
      const parentCols = Object.keys(row).filter(k => !this.isChildField(k))
      if (parentCols.length > 0) {
        const setClauses = parentCols.map(c => `${c} = ?`).join(', ')
        const vals = parentCols.map(c => row[c])
        this.db.run(`UPDATE ${this.tableName} SET ${setClauses} WHERE id = ?`, [...vals, id])
      }

      // Replace child rows if provided
      const childData = this.extractChildData(row)
      for (const child of this.childTables) {
        if (!(child.entityField in childData)) continue
        // Delete existing children, then insert new ones
        this.db.run(`DELETE FROM ${child.tableName} WHERE ${child.parentFk} = ?`, [id])
        const items = childData[child.entityField] || []
        for (let i = 0; i < items.length; i++) {
          const childRow = toRow(items[i])
          if (!childRow.id) childRow.id = crypto.randomUUID()
          childRow[child.parentFk] = id
          if (!childRow.sort_order) childRow.sort_order = i

          const childCols = Object.keys(childRow)
          const childVals = childCols.map(c => childRow[c])
          const childPlaceholders = childCols.map(() => '?').join(', ')
          this.db.run(
            `INSERT INTO ${child.tableName} (${childCols.join(', ')}) VALUES (${childPlaceholders})`,
            childVals,
          )
        }
      }
    })

    transaction()
    return this.findById(id)
  }

  async delete(id: string): Promise<boolean> {
    // Child tables use ON DELETE CASCADE
    const result = this.db.run(`DELETE FROM ${this.tableName} WHERE id = ?`, [id])
    return result.changes > 0
  }

  async count(filter: Filter<T>): Promise<number> {
    const { clause, params } = translateFilter(filter)
    const result = this.db.query(`SELECT COUNT(*) as cnt FROM ${this.tableName} WHERE ${clause}`).get(...params) as { cnt: number }
    return result.cnt
  }

  async aggregate<R = any>(_pipeline: AggregateStage[]): Promise<R[]> {
    // Aggregation is handled per-entity in specialized repository subclasses.
    // The generic fallback is not meaningful for SQLite.
    throw new Error(`aggregate() not implemented for ${this.tableName}. Use a specialized repository.`)
  }

  // ── Batch operations ──

  async createMany(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>[]): Promise<T[]> {
    const ids: string[] = []
    const transaction = this.db.transaction(() => {
      for (const item of data) {
        const id = crypto.randomUUID()
        const now = new Date().toISOString()
        const row = toRow({ ...item, id, createdAt: new Date(now), updatedAt: new Date(now) } as any)

        const childData = this.extractChildData(row)
        const cols = Object.keys(row).filter(k => !this.isChildField(k))
        const vals = cols.map(c => row[c])
        const placeholders = cols.map(() => '?').join(', ')

        this.db.run(`INSERT INTO ${this.tableName} (${cols.join(', ')}) VALUES (${placeholders})`, vals)

        for (const child of this.childTables) {
          const items = childData[child.entityField] || []
          for (let i = 0; i < items.length; i++) {
            const childRow = toRow(items[i])
            if (!childRow.id) childRow.id = crypto.randomUUID()
            childRow[child.parentFk] = id
            if (!childRow.sort_order) childRow.sort_order = i
            const childCols = Object.keys(childRow)
            const childVals = childCols.map(c => childRow[c])
            this.db.run(
              `INSERT INTO ${child.tableName} (${childCols.join(', ')}) VALUES (${childCols.map(() => '?').join(', ')})`,
              childVals,
            )
          }
        }

        ids.push(id)
      }
    })
    transaction()
    return Promise.all(ids.map(id => this.findById(id).then(e => e!)))
  }

  async updateMany(filter: Filter<T>, data: Partial<T>): Promise<number> {
    const { clause, params } = translateFilter(filter)
    const now = new Date().toISOString()
    const row = toRow({ ...data, updatedAt: new Date(now) } as any)
    const parentCols = Object.keys(row).filter(k => !this.isChildField(k))
    if (parentCols.length === 0) return 0

    const setClauses = parentCols.map(c => `${c} = ?`).join(', ')
    const vals = parentCols.map(c => row[c])
    const result = this.db.run(`UPDATE ${this.tableName} SET ${setClauses} WHERE ${clause}`, [...vals, ...params])
    return result.changes
  }

  async deleteMany(filter: Filter<T>): Promise<number> {
    const { clause, params } = translateFilter(filter)
    const result = this.db.run(`DELETE FROM ${this.tableName} WHERE ${clause}`, params)
    return result.changes
  }

  // ── Helpers ──

  protected buildOrderBy(sort: SortSpec): string {
    const parts = Object.entries(sort).map(([field, dir]) => {
      const col = toSnakeCase(field)
      return `${col} ${dir === 1 ? 'ASC' : 'DESC'}`
    })
    return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : ''
  }

  /** Hydrate a parent row with child table data */
  protected async hydrateEntity(row: Record<string, any>): Promise<T> {
    const entity = toEntity<T>(row)

    for (const child of this.childTables) {
      const childRows = this.db.query(
        `SELECT * FROM ${child.tableName} WHERE ${child.parentFk} = ? ORDER BY sort_order`,
      ).all(row.id) as Record<string, any>[]

      ;(entity as any)[child.entityField] = childRows.map(r => toEntity(r))
    }

    return entity
  }

  /** Check if a snake_case column name corresponds to a child table field */
  private isChildField(col: string): boolean {
    return this.childTables.some(c => toSnakeCase(c.entityField) === col)
  }

  /** Extract child data from the row object */
  private extractChildData(row: Record<string, any>): Record<string, any[]> {
    const result: Record<string, any[]> = {}
    for (const child of this.childTables) {
      const snakeField = toSnakeCase(child.entityField)
      if (row[snakeField] !== undefined) {
        let items = row[snakeField]
        if (typeof items === 'string') {
          try { items = JSON.parse(items) } catch { items = [] }
        }
        result[child.entityField] = Array.isArray(items) ? items : []
        delete row[snakeField]
      }
    }
    return result
  }
}

/** Configuration for a child table that stores embedded array data */
export interface ChildTableConfig {
  /** The SQLite table name for the child data */
  tableName: string
  /** The foreign key column in the child table that references the parent */
  parentFk: string
  /** The entity field name (camelCase) on the parent entity */
  entityField: string
}
