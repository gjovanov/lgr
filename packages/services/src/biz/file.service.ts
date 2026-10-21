import { File as FileModel, type IFile } from 'db/models'
import { createHash } from 'node:crypto'
import { config } from 'config'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { logger } from '../logger/logger.js'
import { resolveStored } from './files/stored-path.js'

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
    sha256: createHash('sha256').update(Buffer.from(buffer)).digest('hex'),
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
      // FR-20.24: the row may hold either form of path.
      const onDisk = resolveStored(file.storagePath, file.orgId)
      const bunFile = Bun.file(onDisk)
      if (await bunFile.exists()) {
        await Bun.write(onDisk, '') // clear content
        const { unlink } = await import('fs/promises')
        await unlink(onDisk)
      }
    } catch {
      logger.warn({ fileId, path: file.storagePath }, 'Failed to delete physical file')
    }
  }

  await FileModel.findByIdAndDelete(fileId)
  logger.info({ fileId }, 'File deleted')
}
