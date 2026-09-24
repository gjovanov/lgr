#!/usr/bin/env bun
/**
 * Fiscal Printer Serial-to-TCP Bridge
 *
 * Bridges a USB-connected fiscal printer to a TCP server so LGR
 * (running on a remote server) can communicate with it over the network.
 *
 * Works on both Windows (COM ports) and Linux (/dev/ttyUSB, /dev/ttyACM).
 *
 * Usage:
 *   bun run packages/fiscal/src/bridge.ts                    # Auto-detect port
 *   bun run packages/fiscal/src/bridge.ts --port COM3        # Windows
 *   bun run packages/fiscal/src/bridge.ts --port /dev/ttyUSB0  # Linux
 *   bun run packages/fiscal/src/bridge.ts --tcp-port 4999    # Custom TCP port
 *   bun run packages/fiscal/src/bridge.ts --baud 115200      # Custom baud rate
 *   bun run packages/fiscal/src/bridge.ts --list             # List available ports
 *
 * Then configure the fiscal device in LGR with:
 *   connectionType: "tcp"
 *   connectionParams: { ip: "<your-laptop-ip>", tcpPort: 4999 }
 */

import { SerialPort } from 'serialport'
import { createServer, type Socket } from 'net'
import { networkInterfaces } from 'os'

// ── CLI argument parsing ──

const args = process.argv.slice(2)

function getArg(name: string, defaultValue?: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return defaultValue
}

const LIST_MODE = args.includes('--list')
const SERIAL_PORT = getArg('port')
const TCP_PORT = parseInt(getArg('tcp-port', '4999')!, 10)
const BAUD_RATE = parseInt(getArg('baud', '115200')!, 10)
const BIND_HOST = getArg('bind', '0.0.0.0')!

// ── Color output helpers ──

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

// ── List available serial ports ──

async function listPorts(): Promise<void> {
  const ports = await SerialPort.list()
  if (ports.length === 0) {
    console.log(yellow('No serial ports found.'))
    console.log('Make sure the fiscal printer is connected via USB.')
    if (process.platform === 'linux') {
      console.log('On Linux, check: ls -la /dev/ttyUSB* /dev/ttyACM*')
      console.log('You may need: sudo usermod -a -G dialout $USER')
    }
    if (process.platform === 'win32') {
      console.log('On Windows, check Device Manager > Ports (COM & LPT)')
    }
    return
  }

  console.log(bold('\nAvailable serial ports:\n'))
  console.log('  Port              Manufacturer         VID:PID')
  console.log('  ────              ────────────         ───────')
  for (const port of ports) {
    const mfr = port.manufacturer || ''
    const vid = port.vendorId && port.productId ? `${port.vendorId}:${port.productId}` : ''
    const isFiscal = /tremol|datecs|daisy|eltrade|incotex|ftdi|cp210|ch340|prolific/i.test(
      `${mfr} ${port.pnpId || ''} ${port.serialNumber || ''}`
    )
    const marker = isFiscal ? green(' << likely fiscal printer') : ''
    console.log(`  ${cyan(port.path.padEnd(18))} ${mfr.padEnd(21)} ${vid}${marker}`)
  }
  console.log()
}

// ── Auto-detect fiscal printer port ──

async function autoDetectPort(): Promise<string | null> {
  const ports = await SerialPort.list()

  // Priority 1: Known fiscal printer manufacturers
  const fiscalKeywords = /tremol|datecs|daisy|eltrade|incotex/i
  for (const port of ports) {
    const combined = `${port.manufacturer || ''} ${port.pnpId || ''} ${port.serialNumber || ''}`
    if (fiscalKeywords.test(combined)) return port.path
  }

  // Priority 2: Common USB-to-serial chips used by fiscal printers
  const chipKeywords = /ftdi|cp210|ch340|prolific|stm32|stmicroelectronics/i
  for (const port of ports) {
    const combined = `${port.manufacturer || ''} ${port.pnpId || ''}`
    if (chipKeywords.test(combined)) return port.path
  }

  // Priority 3: On Linux, any /dev/ttyUSB* or /dev/ttyACM*
  if (process.platform === 'linux') {
    for (const port of ports) {
      if (port.path.startsWith('/dev/ttyUSB') || port.path.startsWith('/dev/ttyACM')) {
        return port.path
      }
    }
  }

  // Priority 4: On Windows, any COM port that isn't COM1/COM2 (those are usually built-in)
  if (process.platform === 'win32') {
    for (const port of ports) {
      if (port.path !== 'COM1' && port.path !== 'COM2') {
        return port.path
      }
    }
  }

  return null
}

// ── Get local IP addresses for display ──

function getLocalIPs(): string[] {
  const nets = networkInterfaces()
  const ips: string[] = []
  for (const iface of Object.values(nets)) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address)
      }
    }
  }
  return ips
}

// ── Main bridge ──

async function main() {
  console.log(bold('\n  LGR Fiscal Printer Bridge\n'))

  if (LIST_MODE) {
    await listPorts()
    process.exit(0)
  }

  // Resolve serial port
  let serialPath = SERIAL_PORT
  if (!serialPath) {
    console.log('  Auto-detecting fiscal printer...')
    serialPath = await autoDetectPort()
    if (!serialPath) {
      console.log(red('  No fiscal printer found. Use --list to see available ports.'))
      console.log(`  Or specify manually: bun run bridge.ts --port ${process.platform === 'win32' ? 'COM3' : '/dev/ttyUSB0'}`)
      process.exit(1)
    }
    console.log(`  ${green('Found:')} ${cyan(serialPath)}`)
  }

  // Open serial port
  console.log(`  Opening ${cyan(serialPath)} at ${BAUD_RATE} baud...`)

  const serial = new SerialPort({
    path: serialPath,
    baudRate: BAUD_RATE,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    autoOpen: false,
  })

  await new Promise<void>((resolve, reject) => {
    serial.open((err) => {
      if (err) {
        console.log(red(`  Failed to open ${serialPath}: ${err.message}`))
        if (process.platform === 'linux' && err.message.includes('Permission denied')) {
          console.log(yellow('  Fix: sudo usermod -a -G dialout $USER && logout'))
        }
        reject(err)
      } else {
        resolve()
      }
    })
  })

  console.log(`  ${green('Serial port opened')}`)

  // Track active TCP client (only one at a time — fiscal printer is single-threaded)
  let activeClient: Socket | null = null

  // Start TCP server
  const server = createServer((socket) => {
    const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`

    if (activeClient) {
      console.log(`  ${yellow('Rejecting')} ${clientAddr} — another client is connected`)
      socket.end('BUSY\n')
      return
    }

    activeClient = socket
    console.log(`  ${green('LGR connected')} from ${cyan(clientAddr)}`)

    // TCP → Serial (LGR sends command to printer)
    socket.on('data', (data) => {
      serial.write(data)
    })

    // Serial → TCP (printer responds to LGR)
    const onSerialData = (data: Buffer) => {
      if (activeClient === socket && !socket.destroyed) {
        socket.write(data)
      }
    }
    serial.on('data', onSerialData)

    socket.on('close', () => {
      console.log(`  ${yellow('LGR disconnected')} ${clientAddr}`)
      serial.removeListener('data', onSerialData)
      activeClient = null
    })

    socket.on('error', (err) => {
      console.log(`  ${red('Client error:')} ${err.message}`)
      serial.removeListener('data', onSerialData)
      activeClient = null
    })
  })

  server.listen(TCP_PORT, BIND_HOST, () => {
    const ips = getLocalIPs()

    console.log(`\n  ${green('Bridge is running!')}\n`)
    console.log(`  Serial:  ${cyan(serialPath!)} @ ${BAUD_RATE} baud`)
    console.log(`  TCP:     ${cyan(`${BIND_HOST}:${TCP_PORT}`)}`)
    console.log()
    console.log(bold('  Configure in LGR:'))
    console.log(`  ┌─────────────────────────────────────────────┐`)
    console.log(`  │  connectionType: "tcp"                       │`)
    for (const ip of ips) {
      console.log(`  │  connectionParams.ip: "${ip}"${' '.repeat(Math.max(0, 17 - ip.length))}│`)
    }
    console.log(`  │  connectionParams.tcpPort: ${TCP_PORT}              │`)
    console.log(`  └─────────────────────────────────────────────┘`)
    console.log()
    console.log(`  Waiting for LGR to connect... (Ctrl+C to stop)`)
    console.log()
  })

  // Serial port error handling
  serial.on('error', (err) => {
    console.log(red(`  Serial error: ${err.message}`))
  })

  serial.on('close', () => {
    console.log(red('  Serial port closed — printer may have been disconnected'))
    if (activeClient) {
      activeClient.destroy()
      activeClient = null
    }
  })

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n  Shutting down bridge...')
    if (activeClient) activeClient.destroy()
    server.close()
    serial.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(red(`Fatal: ${err.message}`))
  process.exit(1)
})
