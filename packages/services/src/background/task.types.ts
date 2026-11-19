export interface TaskInfo {
  id: string
  orgId: string
  userId: string
  type: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  params: Record<string, any>
  result?: Record<string, any>
  progress: number
  /**
   * What the task is doing now, as a code: the last `stage` an `updateProgress` named (#772). A screen says the code
   * in the reader's language, where a log line stays as the server wrote it. Absent for a task that names no stages.
   */
  stage?: string
  logs: string[]
  error?: string
  startedAt?: Date
  completedAt?: Date
  createdAt: Date
}

export interface TaskUpdateEvent {
  taskId: string
  status: string
  progress: number
  logs: string[]
  result?: Record<string, any>
  error?: string
}
