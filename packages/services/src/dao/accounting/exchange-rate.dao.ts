import { ExchangeRate, type IExchangeRate } from 'db/models'
import { BaseDao } from '../base.dao.js'

class ExchangeRateDaoClass extends BaseDao<IExchangeRate> {
  constructor() {
    super(ExchangeRate)
  }

  async findRate(
    orgId: string,
    fromCurrency: string,
    toCurrency: string,
    date: Date,
  ): Promise<IExchangeRate | null> {
    return this.model
      .findOne({ orgId, fromCurrency, toCurrency, date: { $lte: date } })
      .sort({ date: -1 })
      .exec()
  }

  async findLatest(
    orgId: string,
    fromCurrency: string,
    toCurrency: string,
  ): Promise<IExchangeRate | null> {
    return this.model
      .findOne({ orgId, fromCurrency, toCurrency })
      .sort({ date: -1 })
      .exec()
  }
}

export const exchangeRateDao = new ExchangeRateDaoClass()
