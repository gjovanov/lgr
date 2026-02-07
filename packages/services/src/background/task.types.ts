export interface TaskInfo {
  id: string
  orgId: string
  userId: string
  type: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  params: Record<string, any>
  result?: Record<string, any>
  progress: number
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
