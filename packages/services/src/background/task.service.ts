import { randomUUID } from 'crypto'
import { BackgroundTask } from 'db/models'
import { taskStore } from './task.store.js'
import type { TaskInfo } from './task.types.js'
import { logger } from '../logger/logger.js'

export async function startJob(
  orgId: string,
  userId: string,
  type: string,
  params: Record<string, any>,
): Promise<TaskInfo> {
  const doc = await BackgroundTask.create({
    orgId,
    userId,
    type,
    status: 'processing',
    params,
    progress: 0,
    logs: [`Job started: ${type}`],
    startedAt: new Date(),
  })

  const task: TaskInfo = {
    id: String(doc._id),
    orgId,
    userId,
    type,
    status: 'processing',
    params,
    progress: 0,
    logs: [`Job started: ${type}`],
    startedAt: new Date(),
    createdAt: doc.createdAt,
  }

  taskStore.set(task.id, task)
  logger.info({ taskId: task.id, type }, 'Background task started')
  return task
}

export async function updateProgress(
  taskId: string,
  progress: number,
  logMessage?: string,
): Promise<void> {
  const task = taskStore.get(taskId)
  if (!task) return

  task.progress = progress
  if (logMessage) task.logs.push(logMessage)
  taskStore.set(taskId, task)

  await BackgroundTask.findByIdAndUpdate(taskId, {
    progress,
    ...(logMessage ? { $push: { logs: logMessage } } : {}),
  })
}

export async function completeJob(
  taskId: string,
  result?: Record<string, any>,
): Promise<void> {
  const task = taskStore.get(taskId)
  if (!task) return

  task.status = 'completed'
  task.progress = 100
  task.result = result
  task.completedAt = new Date()
  task.logs.push('Job completed successfully')
  taskStore.set(taskId, task)

  await BackgroundTask.findByIdAndUpdate(taskId, {
    status: 'completed',
    progress: 100,
    result,
    completedAt: new Date(),
    $push: { logs: 'Job completed successfully' },
  })

  logger.info({ taskId }, 'Background task completed')
}

export async function failJob(
  taskId: string,
  error: string,
): Promise<void> {
  const task = taskStore.get(taskId)
  if (!task) return

  task.status = 'failed'
  task.error = error
  task.completedAt = new Date()
  task.logs.push(`Job failed: ${error}`)
  taskStore.set(taskId, task)

  await BackgroundTask.findByIdAndUpdate(taskId, {
    status: 'failed',
    error,
    completedAt: new Date(),
    $push: { logs: `Job failed: ${error}` },
  })

  logger.error({ taskId, error }, 'Background task failed')
}
