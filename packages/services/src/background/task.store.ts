import { EventEmitter } from 'events'
import type { TaskInfo } from './task.types.js'

/**
 * FR-29.28: a finished task leaves this store after `FINISHED_TASK_TTL_MS`. The store is a cache of the running tasks of
 * this process; the `BackgroundTask` row is the record, and every task route falls back to it (the document import's,
 * the files', the backup's). It used to keep every task until the process ended.
 */
export const FINISHED_TASK_TTL_MS = 10 * 60_000
const FINISHED = new Set(['completed', 'failed', 'cancelled'])

class BackgroundTaskStore extends EventEmitter {
  private tasks = new Map<string, TaskInfo>()
  /** When each finished task finished, by id. */
  private finishedAt = new Map<string, number>()

  /** Forget the tasks that finished more than `ttlMs` ago. Called on every write; exported for tests. */
  sweep(now = Date.now(), ttlMs = FINISHED_TASK_TTL_MS): number {
    let gone = 0
    for (const [id, at] of this.finishedAt) {
      if (now - at < ttlMs) continue
      this.tasks.delete(id)
      this.finishedAt.delete(id)
      gone++
    }
    return gone
  }

  /** How many tasks the store holds (health, tests). */
  get size(): number {
    return this.tasks.size
  }

  get(taskId: string): TaskInfo | undefined {
    return this.tasks.get(taskId)
  }

  getByUser(userId: string): TaskInfo[] {
    return [...this.tasks.values()].filter(t => t.userId === userId)
  }

  getByOrg(orgId: string): TaskInfo[] {
    return [...this.tasks.values()].filter(t => t.orgId === orgId)
  }

  set(taskId: string, task: TaskInfo): void {
    this.sweep()
    this.tasks.set(taskId, task)
    if (FINISHED.has(String(task.status))) {
      if (!this.finishedAt.has(taskId)) this.finishedAt.set(taskId, Date.now())
    } else {
      this.finishedAt.delete(taskId)
    }
    this.emit('task:update', {
      taskId,
      status: task.status,
      progress: task.progress,
      logs: task.logs,
      result: task.result,
      error: task.error,
    })
  }

  delete(taskId: string): void {
    this.tasks.delete(taskId)
    this.finishedAt.delete(taskId)
  }

  clear(): void {
    this.tasks.clear()
    this.finishedAt.clear()
  }
}

export const taskStore = new BackgroundTaskStore()
