import { File as FileModel, type IFile } from 'db/models'
import { config } from 'config'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { logger } from '../logger/logger.js'

export async function uploadFile(
  orgId: string,
  userId: string,
  module: string,
  file: { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> },
): Promise<IFile> {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const dir = join(config.upload.dir, orgId, module, String(year), month)

  await mkdir(dir, { recursive: true })

  const uniqueName = `${Date.now()}-${file.name}`
  const filePath = join(dir, uniqueName)
  const buffer = await file.arrayBuffer()
  await Bun.write(filePath, buffer)

  const doc = await FileModel.create({
    orgId,
    uploadedBy: userId,
    originalName: file.name,
    storagePath: filePath,
    storageProvider: 'local',
    mimeType: file.type,
    size: file.size,
    module,
  })

  logger.info({ fileId: doc._id, name: file.name, module }, 'File uploaded')
  return doc
}

export async function deleteFile(fileId: string): Promise<void> {
  const file = await FileModel.findById(fileId)
  if (!file) throw new Error('File not found')

  if (file.storageProvider === 'local') {
    try {
      const bunFile = Bun.file(file.storagePath)
      if (await bunFile.exists()) {
        await Bun.write(file.storagePath, '') // clear content
        const { unlink } = await import('fs/promises')
        await unlink(file.storagePath)
      }
    } catch {
      logger.warn({ fileId, path: file.storagePath }, 'Failed to delete physical file')
    }
  }

  await FileModel.findByIdAndDelete(fileId)
  logger.info({ fileId }, 'File deleted')
}
