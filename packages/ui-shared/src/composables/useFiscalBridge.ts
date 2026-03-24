/**
 * Fiscal Bridge Composable — Web Serial API + WebSocket relay.
 *
 * Opens a USB-connected fiscal printer via the Web Serial API (Chrome/Edge 89+)
 * and relays Datecs protocol commands from the LGR server via WebSocket.
 *
 * Usage in POS view:
 *   const { status, errorMessage, isSupported, requestPort, connect, disconnect } = useFiscalBridge()
 */

import { ref, onUnmounted, type Ref } from 'vue'

export type FiscalBridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// Frame delimiter — Datecs ETX byte marking end of response
const ETX_FRAME = 0x03

export function useFiscalBridge() {
  const status: Ref<FiscalBridgeStatus> = ref('disconnected')
  const errorMessage = ref('')
  const deviceNumber = ref('')

  const isSupported = typeof navigator !== 'undefined' && 'serial' in navigator

  let serialPort: any = null
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  let ws: WebSocket | null = null

  /**
   * Request a serial port from the browser's picker dialog.
   * Must be called from a user gesture (click handler).
   */
  async function requestPort(): Promise<boolean> {
    if (!isSupported) {
      errorMessage.value = 'Web Serial API not supported in this browser. Use Chrome or Edge.'
      status.value = 'error'
      return false
    }

    try {
      serialPort = await (navigator as any).serial.requestPort({
        filters: [
          { usbVendorId: 0x0483 }, // STMicroelectronics (Tremol M20, S25, etc.)
          { usbVendorId: 0x0403 }, // FTDI FT232R
          { usbVendorId: 0x10C4 }, // Silicon Labs CP210x
          { usbVendorId: 0x1A86 }, // QinHeng CH340
          { usbVendorId: 0x067B }, // Prolific PL2303
        ],
      })

      await serialPort.open({ baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 })
      reader = serialPort.readable.getReader()
      writer = serialPort.writable.getWriter()

      return true
    } catch (e: any) {
      if (e.name === 'NotFoundError') {
        // User cancelled the picker
        return false
      }
      errorMessage.value = `Failed to open serial port: ${e.message}`
      status.value = 'error'
      return false
    }
  }

  /**
   * Connect to LGR's fiscal bridge WebSocket and start relaying commands.
   */
  async function connect(orgId: string, devNumber: string, warehouseId: string): Promise<boolean> {
    if (!serialPort || !reader || !writer) {
      errorMessage.value = 'Serial port not open. Call requestPort() first.'
      status.value = 'error'
      return false
    }

    deviceNumber.value = devNumber
    status.value = 'connecting'

    try {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${protocol}//${location.host}/ws/fiscal-bridge`)

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000)
        ws!.onopen = () => { clearTimeout(timeout); resolve() }
        ws!.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket connection failed')) }
      })

      // Register as fiscal bridge
      ws.send(JSON.stringify({
        type: 'fiscal:bridge:register',
        deviceNumber: devNumber,
        orgId,
        warehouseId,
      }))

      // Wait for registration confirmation
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Bridge registration timeout')), 10000)
        const origHandler = ws!.onmessage
        ws!.onmessage = (event) => {
          const msg = JSON.parse(event.data)
          if (msg.type === 'fiscal:bridge:registered') {
            clearTimeout(timeout)
            resolve()
          } else if (msg.type === 'fiscal:bridge:error') {
            clearTimeout(timeout)
            reject(new Error(msg.message))
          }
        }
      })

      // Enter command relay loop
      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type === 'fiscal:command') {
          await relayCommand(msg.commandId, msg.frame)
        }
      }

      ws.onclose = () => {
        status.value = 'disconnected'
        deviceNumber.value = ''
      }

      ws.onerror = () => {
        status.value = 'error'
        errorMessage.value = 'WebSocket connection lost'
      }

      status.value = 'connected'
      errorMessage.value = ''
      return true
    } catch (e: any) {
      errorMessage.value = e.message
      status.value = 'error'
      return false
    }
  }

  /**
   * Relay a single fiscal command: decode base64 frame → write to serial → read response → send back.
   */
  async function relayCommand(commandId: string, frameBase64: string) {
    if (!reader || !writer || !ws) return

    try {
      // Decode and write to serial port
      const frame = Uint8Array.from(atob(frameBase64), c => c.charCodeAt(0))
      await writer.write(frame)

      // Read response until ETX_FRAME byte
      const chunks: Uint8Array[] = []
      const readTimeout = setTimeout(() => {
        // Force-resolve on timeout
        if (ws) {
          ws.send(JSON.stringify({
            type: 'fiscal:response:error',
            commandId,
            error: 'Serial read timeout (10s)',
          }))
        }
      }, 10000)

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          // Check if response is complete (ends with ETX_FRAME byte)
          if (value[value.length - 1] === ETX_FRAME) break
        }
      }

      clearTimeout(readTimeout)

      // Concatenate chunks and encode as base64
      const totalLen = chunks.reduce((s, c) => s + c.length, 0)
      const response = new Uint8Array(totalLen)
      let offset = 0
      for (const chunk of chunks) {
        response.set(chunk, offset)
        offset += chunk.length
      }

      const responseBase64 = btoa(String.fromCharCode(...response))

      ws.send(JSON.stringify({
        type: 'fiscal:response',
        commandId,
        frame: responseBase64,
      }))
    } catch (e: any) {
      if (ws) {
        ws.send(JSON.stringify({
          type: 'fiscal:response:error',
          commandId,
          error: e.message,
        }))
      }
      status.value = 'error'
      errorMessage.value = `Serial error: ${e.message}`
    }
  }

  /**
   * Disconnect serial port and WebSocket.
   */
  async function disconnect() {
    try {
      if (reader) { reader.releaseLock(); reader = null }
      if (writer) { writer.releaseLock(); writer = null }
      if (serialPort) { await serialPort.close(); serialPort = null }
    } catch { /* best-effort */ }
    try {
      if (ws) { ws.close(); ws = null }
    } catch { /* best-effort */ }
    status.value = 'disconnected'
    deviceNumber.value = ''
    errorMessage.value = ''
  }

  onUnmounted(() => {
    disconnect()
  })

  return {
    status,
    errorMessage,
    deviceNumber,
    isSupported,
    requestPort,
    connect,
    disconnect,
  }
}
