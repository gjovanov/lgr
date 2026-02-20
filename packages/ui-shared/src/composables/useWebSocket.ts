import { ref, onUnmounted } from 'vue'

const isConnected = ref(false)
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10

type MessageHandler = (data: any) => void
const handlers: MessageHandler[] = []

export function useWebSocket() {
  function connect(userId: string) {
    if (ws?.readyState === WebSocket.OPEN) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${window.location.host}/ws/tasks?userId=${userId}`

    ws = new WebSocket(url)

    ws.onopen = () => {
      isConnected.value = true
      reconnectAttempts = 0
      // Start heartbeat
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 30000)
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'pong') return
        handlers.forEach(h => h(data))
      } catch {
        // ignore parse errors
      }
    }

    ws.onclose = () => {
      isConnected.value = false
      if (pingTimer) clearInterval(pingTimer)

      // Exponential backoff reconnect
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
        reconnectTimer = setTimeout(() => {
          reconnectAttempts++
          connect(userId)
        }, delay)
      }
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (pingTimer) clearInterval(pingTimer)
    reconnectAttempts = MAX_RECONNECT_ATTEMPTS // prevent reconnect
    ws?.close()
    ws = null
    isConnected.value = false
  }

  function onMessage(handler: MessageHandler) {
    handlers.push(handler)
  }

  function removeHandler(handler: MessageHandler) {
    const idx = handlers.indexOf(handler)
    if (idx >= 0) handlers.splice(idx, 1)
  }

  onUnmounted(() => {
    // Clean up handlers registered by this component
  })

  return { connect, disconnect, isConnected, onMessage, removeHandler }
}
