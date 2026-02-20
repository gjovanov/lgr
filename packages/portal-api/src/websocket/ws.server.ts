import type { Elysia } from 'elysia'
import { taskStore } from 'services/background/task.store'
import { logger } from 'services/logger'

interface WSData {
  userId: string
  orgId: string
}

const connections = new Map<string, Set<any>>()

export function setupWebSocket(app: Elysia<any, any, any, any, any, any, any, any>) {
  // Listen for task updates and broadcast to relevant users
  taskStore.on('task:update', (event) => {
    const task = taskStore.get(event.taskId)
    if (!task) return

    const userConns = connections.get(task.userId)
    if (!userConns) return

    const message = JSON.stringify({ type: 'task:update', data: event })
    for (const ws of userConns) {
      try {
        ws.send(message)
      } catch {
        userConns.delete(ws)
      }
    }
  })

  return app.ws('/ws/tasks', {
    open(ws) {
      const userId = (ws.data as any).query?.userId
      if (!userId) {
        ws.close()
        return
      }

      if (!connections.has(userId)) {
        connections.set(userId, new Set())
      }
      connections.get(userId)!.add(ws)
      logger.info({ userId }, 'WebSocket connected')
    },

    message(ws, message: any) {
      if (typeof message === 'string') {
        try {
          const parsed = JSON.parse(message)
          if (parsed.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
          }
        } catch {
          // ignore invalid messages
        }
      }
    },

    close(ws) {
      const userId = (ws.data as any).query?.userId
      if (userId && connections.has(userId)) {
        connections.get(userId)!.delete(ws)
        if (connections.get(userId)!.size === 0) {
          connections.delete(userId)
        }
      }
      logger.info({ userId }, 'WebSocket disconnected')
    },
  })
}

export function sendNotification(userId: string, notification: object) {
  const userConns = connections.get(userId)
  if (!userConns) return

  const message = JSON.stringify({ type: 'notification', data: notification })
  for (const ws of userConns) {
    try {
      ws.send(message)
    } catch {
      userConns.delete(ws)
    }
  }
}
