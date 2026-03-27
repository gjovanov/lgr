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

// Frame delimiters — Datecs uses 0x03, Tremol uses 0x0A (LF)
const ETX_DATECS = 0x03
const ETX_TREMOL = 0x0A
// ACK/NAK single-byte responses (Tremol)
const ACK = 0x06
const NAK = 0x15

export function useFiscalBridge() {
  const status: Ref<FiscalBridgeStatus> = ref('disconnected')
  const errorMessage = ref('')
  const deviceNumber = ref('')
  const selectedBaudRate = ref(115200)
  const baudRateOptions = [9600, 19200, 38400, 57600, 115200]

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

      await serialPort.open({ baudRate: selectedBaudRate.value, dataBits: 8, parity: 'none', stopBits: 1 })

      // Assert DTR + RTS signals — required by STM32 CDC ACM (Tremol M20)
      // Without these, the device ignores all data on the USB virtual COM port
      try {
        await serialPort.setSignals({ dataTerminalReady: true, requestToSend: true })
      } catch { /* some ports don't support setSignals */ }

      reader = serialPort.readable.getReader()
      writer = serialPort.writable.getWriter()

      // Drain any stale data in the serial buffer from previous sessions
      try {
        const drainTimeout = setTimeout(() => reader!.cancel(), 500)
        try {
          while (true) {
            const { done } = await reader!.read()
            if (done) break
          }
        } catch { /* timeout cancel triggers this */ }
        clearTimeout(drainTimeout)
        // Re-create reader after cancel
        try { reader!.releaseLock() } catch {}
        reader = serialPort.readable.getReader()
      } catch { /* best-effort drain */ }

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
   *
   * Tremol two-phase response protocol:
   *   Phase 1: Device sends ACK (0x06) — "frame received"
   *   Phase 2: Device sends response frame (STX 0x02 ... ETX 0x0A) — the actual result
   * We must read BOTH phases. Breaking on ACK alone leaves the response frame
   * in the serial buffer, causing cascading read offsets for subsequent commands.
   */
  async function relayCommand(commandId: string, frameBase64: string) {
    if (!reader || !writer || !ws) return

    try {
      // Decode and write to serial port
      const frame = Uint8Array.from(atob(frameBase64), c => c.charCodeAt(0))
      await writer.write(frame)

      // Read response until ETX byte (0x0A for Tremol, 0x03 for Datecs).
      // Tremol response: ACK(06) + extended status bytes + ETX(0A)
      // or for data commands: ACK(06) + STX(02) LEN SEQ CMD DATA CS CS ETX(0A)
      // NAK (0x15) is a terminal single-byte error.
      const chunks: Uint8Array[] = []
      let timedOut = false
      const readTimeout = setTimeout(() => {
        timedOut = true
        if (reader) reader.cancel()
      }, 30000) // 30s — device may be physically printing (step-by-step mode)

      while (true) {
        const { value, done } = await reader!.read()
        if (done || timedOut) break
        if (value) {
          chunks.push(value)
          // NAK alone = terminal error
          if (chunks.length === 1 && value.length === 1 && value[0] === NAK) break
          // Check last byte of latest chunk for ETX
          const lastByte = value[value.length - 1]
          if (lastByte === ETX_TREMOL || lastByte === ETX_DATECS) break
        }
      }

      clearTimeout(readTimeout)

      if (timedOut) {
        try { reader = serialPort.readable.getReader() } catch {}
        if (ws) {
          ws.send(JSON.stringify({
            type: 'fiscal:response:error',
            commandId,
            error: 'Serial read timeout (30s)',
          }))
        }
        return
      }

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
    selectedBaudRate,
    baudRateOptions,
    isSupported,
    requestPort,
    connect,
    disconnect,
  }
}
