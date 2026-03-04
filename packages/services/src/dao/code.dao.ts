import { Code, type ICode } from 'db/models'
import { nanoid } from 'nanoid'

class CodeDaoClass {
  async createActivationCode(userId: string, orgId: string, ttlMinutes: number): Promise<{ code: ICode; token: string }> {
    await Code.deleteMany({ userId, type: 'user_activation' }).exec()
    const token = nanoid(7)
    const validTo = new Date(Date.now() + ttlMinutes * 60 * 1000)
    const code = await Code.create({ userId, orgId, token, type: 'user_activation', validTo })
    return { code, token }
  }

  async findActivationCode(userId: string, token: string): Promise<ICode | null> {
    return Code.findOne({
      userId,
      token,
      type: 'user_activation',
      validTo: { $gt: new Date() },
    }).exec()
  }

  async deleteForUser(userId: string): Promise<void> {
    await Code.deleteMany({ userId, type: 'user_activation' }).exec()
  }
}

export const codeDao = new CodeDaoClass()
