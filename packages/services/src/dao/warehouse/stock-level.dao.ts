import { StockLevel, type IStockLevel } from 'db/models'
import { BaseDao } from '../base.dao.js'

class StockLevelDaoClass extends BaseDao<IStockLevel> {
  constructor() {
    super(StockLevel)
  }

  async findByProduct(orgId: string, productId: string): Promise<IStockLevel[]> {
    return this.model.find({ orgId, productId }).exec()
  }

  async findByWarehouse(orgId: string, warehouseId: string): Promise<IStockLevel[]> {
    return this.model.find({ orgId, warehouseId }).exec()
  }

  async findByProductAndWarehouse(
    orgId: string,
    productId: string,
    warehouseId: string,
  ): Promise<IStockLevel | null> {
    return this.model.findOne({ orgId, productId, warehouseId }).exec()
  }

  async adjustQuantity(
    orgId: string,
    productId: string,
    warehouseId: string,
    quantity: number,
    cost: number,
  ): Promise<IStockLevel> {
    const existing = await this.model.findOne({ orgId, productId, warehouseId }).exec()
    if (existing) {
      existing.quantity += quantity
      existing.availableQuantity = existing.quantity - existing.reservedQuantity
      if (quantity > 0 && cost > 0) {
        const totalCost = existing.avgCost * (existing.quantity - quantity) + cost * quantity
        existing.avgCost = totalCost / existing.quantity
      }
      return existing.save()
    }
    return this.model.create({
      orgId,
      productId,
      warehouseId,
      quantity,
      reservedQuantity: 0,
      availableQuantity: quantity,
      avgCost: cost,
    } as Partial<IStockLevel>) as Promise<IStockLevel>
  }
}

export const stockLevelDao = new StockLevelDaoClass()
