/**
 * Fiscal Bridge Composable — Web Serial API + WebSocket relay.
 *
 * Opens a USB-connected fiscal printer via the Web Serial API (Chrome/Edge 89+)
 * and relays Datecs/Tremol protocol commands from the LGR server via WebSocket.
 *
 * State is stored at MODULE level (singleton) so the connection persists
 * across Vue router navigation. Only explicit disconnect() closes it.
 *
 * Usage:
 *   const bridge = useFiscalBridge()
 *   await bridge.requestPort()          // user gesture: select COM port
 *   await bridge.connect(orgId, devNum) // open WebSocket + register bridge
 *   // ... navigate between pages — connection stays alive
 *   await bridge.disconnect()           // explicit teardown
 */

import { ref } from 'vue'

export type FiscalBridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

// Frame delimiters — Datecs uses 0x03, Tremol uses 0x0A (LF)
const ETX_DATECS = 0x03
const ETX_TREMOL = 0x0A
// ACK/NAK single-byte responses (Tremol)
const NAK = 0x15

// ─── Module-level singleton state (survives component unmount + navigation) ───
const status = ref<FiscalBridgeStatus>('disconnected')
const errorMessage = ref('')
const deviceNumber = ref('')
const selectedBaudRate = ref(115200)
const baudRateOptions = [9600, 19200, 38400, 57600, 115200]
const isSupported = typeof navigator !== 'undefined' && 'serial' in navigator

let serialPort: any = null
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
let ws: WebSocket | null = null

// Remember last connection params for auto-reconnect
let lastOrgId = ''
let lastDeviceNumber = ''
let lastWarehouseId = ''

// Listen for device reconnect (USB plugged back in / powered on)
if (isSupported) {
  (navigator as any).serial.addEventListener('connect', async (event: any) => {
    // Only auto-reconnect if we were previously connected and lost it
    if (status.value !== 'error' || !lastDeviceNumber) return

    // Longer delay to let the USB device fully initialize after power-on
    await new Promise(r => setTimeout(r, 2000))

    status.value = 'reconnecting'
    errorMessage.value = 'Device detected — reconnecting...'
    try {
      // Chrome's connect event provides the port via event.port (SerialPort instance)
      let targetPort = event?.port
      if (!targetPort) {
        // Fallback: get from granted ports list
        const ports = await (navigator as any).serial.getPorts()
        targetPort = ports.length > 0 ? ports[0] : null
      }
      if (!targetPort) {
        status.value = 'disconnected'
        errorMessage.value = 'Device detected but port not available. Reconnect manually.'
        return
      }

      serialPort = targetPort
      await serialPort.open({ baudRate: selectedBaudRate.value, dataBits: 8, parity: 'none', stopBits: 1 })
      try { await serialPort.setSignals({ dataTerminalReady: true, requestToSend: true }) } catch {}
      reader = serialPort.readable.getReader()
      writer = serialPort.writable.getWriter()
      serialPort.addEventListener('disconnect', handlePortDisconnect)

      // Re-establish WebSocket bridge
      await connect(lastOrgId, lastDeviceNumber, lastWarehouseId)
    } catch (e: any) {
      // On failure, set to disconnected (not error) so user can manually reconnect
      // without the UI being stuck in error state
      status.value = 'disconnected'
      errorMessage.value = `Auto-reconnect failed: ${e.message}. Reconnect manually.`
      // Clean up partial state
      if (serialPort) {
        try { if (reader) { reader.releaseLock(); reader = null } } catch {}
        try { if (writer) { writer.releaseLock(); writer = null } } catch {}
        try { await serialPort.close() } catch {}
        serialPort = null
      }
    }
  })
}

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
    try {
      await serialPort.setSignals({ dataTerminalReady: true, requestToSend: true })
    } catch { /* some ports don't support setSignals */ }

    reader = serialPort.readable.getReader()
    writer = serialPort.writable.getWriter()

    // Listen for device disconnect (USB unplugged / powered off)
    serialPort.addEventListener('disconnect', handlePortDisconnect)

    return true
  } catch (e: any) {
    if (e.name === 'NotFoundError') return false // User cancelled picker
    errorMessage.value = `Failed to open serial port: ${e.message}`
    status.value = 'error'
    return false
  }
}

/**
 * Connect to LGR's fiscal bridge WebSocket and start relaying commands.
 */
async function connect(orgId: string, devNumber: string, warehouseId?: string): Promise<boolean> {
  if (!serialPort || !reader || !writer) {
    errorMessage.value = 'Serial port not open. Call requestPort() first.'
    status.value = 'error'
    return false
  }

  deviceNumber.value = devNumber
  lastOrgId = orgId
  lastDeviceNumber = devNumber
  lastWarehouseId = warehouseId || ''
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
      warehouseId: warehouseId || '',
    }))

    // Wait for registration confirmation
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bridge registration timeout')), 10000)
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
    const frame = Uint8Array.from(atob(frameBase64), c => c.charCodeAt(0))
    await writer.write(frame)

    const chunks: Uint8Array[] = []
    let timedOut = false
    const readTimeout = setTimeout(() => {
      timedOut = true
      if (reader) reader.cancel()
    }, 30000)

    while (true) {
      const { value, done } = await reader!.read()
      if (done || timedOut) break
      if (value) {
        chunks.push(value)
        if (chunks.length === 1 && value.length === 1 && value[0] === NAK) break
        const lastByte = value[value.length - 1]
        if (lastByte === ETX_TREMOL || lastByte === ETX_DATECS) break
      }
    }

    clearTimeout(readTimeout)

    if (timedOut) {
      // reader.cancel() closes the readable stream — reopen serial port to recover
      try {
        if (reader) { try { reader.releaseLock() } catch {} }
        if (writer) { try { writer.releaseLock() } catch {} }
        await serialPort.close()
        await serialPort.open({ baudRate: selectedBaudRate.value, dataBits: 8, parity: 'none', stopBits: 1 })
        try { await serialPort.setSignals({ dataTerminalReady: true, requestToSend: true }) } catch {}
        reader = serialPort.readable.getReader()
        writer = serialPort.writable.getWriter()
      } catch {
        status.value = 'error'
        errorMessage.value = 'Serial port recovery failed after timeout'
      }
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

    ws.send(JSON.stringify({
      type: 'fiscal:response',
      commandId,
      frame: btoa(String.fromCharCode(...response)),
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
 * Handle unexpected serial port disconnect (USB unplugged / device powered off).
 * Cleans up state and notifies the user via reactive status.
 */
function handlePortDisconnect() {
  reader = null
  writer = null
  serialPort = null
  try { if (ws) { ws.close(); ws = null } } catch {}
  status.value = 'error'
  errorMessage.value = 'Fiscal device disconnected (USB unplugged or powered off)'
  deviceNumber.value = ''
}

/**
 * Disconnect serial port and WebSocket. Only call explicitly — NOT on unmount.
 */
async function disconnect() {
  try {
    if (serialPort) serialPort.removeEventListener('disconnect', handlePortDisconnect)
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

/**
 * Composable — returns the shared singleton state + methods.
 * No onUnmounted hook — connection persists across navigation.
 */
export function useFiscalBridge() {
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
