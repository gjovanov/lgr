import { EventEmitter } from 'events'
import type { TaskInfo } from './task.types.js'

class BackgroundTaskStore extends EventEmitter {
  private tasks = new Map<string, TaskInfo>()

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
    this.tasks.set(taskId, task)
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
  }

  clear(): void {
    this.tasks.clear()
  }
}

export const taskStore = new BackgroundTaskStore()
