/**
 * Fiscal Bridge Composable — Web Serial API + WebSocket relay.
 *
 * Opens a USB-connected fiscal printer via the Web Serial API (Chrome/Edge 89+)
 * and relays Datecs/Tremol/Eltrade protocol commands from the LGR server via WebSocket.
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
import { IslResponseCollector } from './fiscalIslResponse'

export type FiscalBridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/** What the server read from the device right after the bridge registered (Eltrade). */
export interface FiscalBridgeDeviceInfo {
  deviceNumber: string
  /** false = the port opened but the device never answered (wrong port / not in PC mode). */
  responding: boolean
  model?: string
  serialNumber?: string
  fiscalMemoryNumber?: string
  firmwareVersion?: string
  fiscalized?: boolean
  paperPresent?: boolean
  /** The device reports a serial number other than the configured device number. */
  serialMismatch?: boolean
  errors: string[]
  warnings: string[]
}

// Frame delimiters — Datecs uses 0x03, Tremol uses 0x0A (LF)
const ETX_DATECS = 0x03
const ETX_TREMOL = 0x0A
// ACK/NAK single-byte responses (Tremol)
const NAK = 0x15

// ISL (Eltrade) read budget: the device answers within 60 ms and sends SYN every 60 ms
// while busy, so a silent line is detected fast instead of after the fixed 30 s.
const ISL_FIRST_BYTE_MS = 2500
const ISL_IDLE_MS = 8000
const ISL_DEFAULT_BUDGET_MS = 30000
/** Budgets above this (Z-report, fiscal-memory reports) are waited out without idle limits. */
const ISL_LONG_COMMAND_MS = 60000

// ─── Module-level singleton state (survives component unmount + navigation) ───
const status = ref<FiscalBridgeStatus>('disconnected')
const errorMessage = ref('')
const deviceNumber = ref('')
const manufacturer = ref('')
const deviceInfo = ref<FiscalBridgeDeviceInfo | null>(null)
const selectedBaudRate = ref(115200)
const baudRateOptions = [9600, 19200, 38400, 57600, 115200]
const isSupported = typeof navigator !== 'undefined' && 'serial' in navigator

/** One command on the wire at a time — two interleaved frames on one serial line are garbage. */
let relayQueue: Promise<void> = Promise.resolve()

let serialPort: any = null
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
let ws: WebSocket | null = null

// Remember last connection params for auto-reconnect
let lastOrgId = ''
let lastDeviceNumber = ''
let lastWarehouseId = ''
let portDisconnecting = false // flag to prevent ws.onclose from overriding error status

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
    // No vendor filter. The list used to allow only a few USB-serial chips (STM32, FTDI,
    // CP210x, CH340, PL2303); a device on any other chip — an Eltrade A3, a Bluetooth SPP
    // link, a native COM port — was simply missing from the picker, with no hint why.
    serialPort = await (navigator as any).serial.requestPort()

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
  deviceInfo.value = null
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
          manufacturer.value = msg.manufacturer || ''
          resolve()
        } else if (msg.type === 'fiscal:bridge:error') {
          clearTimeout(timeout)
          reject(new Error(msg.message))
        }
      }
    })

    // Enter command relay loop
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.type === 'fiscal:command') {
        // Chained, not awaited in the handler: a handler per message runs concurrently, and
        // two commands must never share the serial line at once.
        relayQueue = relayQueue
          .then(() => relayCommand(msg.commandId, msg.frame, msg.protocol, msg.timeoutMs))
          .catch(() => { /* relayCommand reports its own failures; keep the queue alive */ })
      } else if (msg.type === 'fiscal:bridge:info') {
        deviceInfo.value = {
          deviceNumber: msg.deviceNumber,
          responding: !!msg.responding,
          ...(msg.device || {}),
          errors: msg.device?.errors || [],
          warnings: msg.device?.warnings || [],
        }
      }
    }

    ws.onclose = () => {
      // Don't override 'error' status set by handlePortDisconnect
      if (!portDisconnecting) {
        status.value = 'disconnected'
        deviceNumber.value = ''
      }
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
 * After a read timeout: reader.cancel() has closed the readable stream, so reopen the port to
 * get fresh streams. Leaves the bridge in 'error' if the port will not come back.
 */
async function reopenSerialPort(): Promise<void> {
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
}

/**
 * ISL (Eltrade) relay: write the frame, then read until the answer carrying its SEQ arrives.
 *
 * Differs from the heuristic relay in three ways that matter on a real line:
 *  - it stops on the answer to THIS command, dropping a late answer to an earlier one;
 *  - SYN bytes (busy, every 60 ms) extend the wait, so a long print is not cut off, while a
 *    device that never answers is given up on after ISL_FIRST_BYTE_MS, not 30 s;
 *  - a bare NAK is returned at once so the server can resend.
 */
async function relayIslCommand(commandId: string, frameBase64: string, timeoutMs?: number) {
  if (!ws) return
  if (!reader || !writer) {
    // Answer instead of dropping the command — otherwise the server waits out its full timeout.
    ws.send(JSON.stringify({ type: 'fiscal:response:error', commandId, error: 'Serial port not open — device disconnected' }))
    return
  }
  const budget = timeoutMs && timeoutMs > 0 ? timeoutMs : ISL_DEFAULT_BUDGET_MS
  const long = budget > ISL_LONG_COMMAND_MS
  const deadline = Date.now() + budget

  try {
    const frame = Uint8Array.from(atob(frameBase64), c => c.charCodeAt(0))
    const collector = new IslResponseCollector(frame[2])
    await writer.write(frame)

    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        if (reader) reader.cancel()
      }, Math.max(1, Math.min(ms, deadline - Date.now())))
    }
    arm(long ? budget : ISL_FIRST_BYTE_MS)

    let state: 'more' | 'frame' | 'nak' = 'more'
    while (true) {
      const { value, done } = await reader!.read()
      if (done || timedOut) break
      if (value && value.length) {
        state = collector.push(value)
        if (state !== 'more') break
        arm(long ? budget : ISL_IDLE_MS)
      }
    }
    clearTimeout(timer)

    if (!timedOut && state === 'more') {
      // The stream ended under us (port closed / device unplugged) before a full answer.
      if (ws) ws.send(JSON.stringify({ type: 'fiscal:response:error', commandId, error: 'Serial port closed while reading the answer — device disconnected' }))
      return
    }

    if (timedOut) {
      const heard = collector.received > 0
      await reopenSerialPort()
      if (ws) {
        ws.send(JSON.stringify({
          type: 'fiscal:response:error',
          commandId,
          error: heard
            ? 'Serial read timeout — the device stopped answering mid-response'
            : 'Serial read timeout — no answer from the device',
        }))
      }
      return
    }

    ws.send(JSON.stringify({
      type: 'fiscal:response',
      commandId,
      frame: btoa(String.fromCharCode(...collector.bytes())),
    }))
  } catch (e: any) {
    if (ws) {
      ws.send(JSON.stringify({ type: 'fiscal:response:error', commandId, error: e.message }))
    }
    status.value = 'error'
    errorMessage.value = `Serial error: ${e.message}`
  }
}

/**
 * Relay a single fiscal command: decode base64 frame → write to serial → read response → send back.
 * `protocol: 'isl'` (Eltrade) switches to the frame-aware reader; without it the original
 * Datecs/Tremol heuristic below runs unchanged.
 */
async function relayCommand(commandId: string, frameBase64: string, protocol?: string, timeoutMs?: number) {
  if (protocol === 'isl') return relayIslCommand(commandId, frameBase64, timeoutMs)
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
      await reopenSerialPort()
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
  portDisconnecting = true
  status.value = 'error'
  errorMessage.value = 'Fiscal device disconnected (USB unplugged or powered off)'
  try { if (ws) { ws.close(); ws = null } } catch {}
  // Reset flag after a tick so future ws.onclose works normally
  setTimeout(() => { portDisconnecting = false }, 100)
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
  manufacturer.value = ''
  deviceInfo.value = null
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
    manufacturer,
    deviceInfo,
    selectedBaudRate,
    baudRateOptions,
    isSupported,
    requestPort,
    connect,
    disconnect,
  }
}
