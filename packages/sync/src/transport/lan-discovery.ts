import { networkInterfaces } from 'os'

export interface Peer {
  address: string
  port: number
  name: string
  deviceId: string
  orgId: string
}

export interface LANDiscoveryOptions {
  syncPort: number
  deviceId: string
  deviceName: string
  orgId: string
  broadcastPort?: number
  broadcastInterval?: number
}

/**
 * Simple UDP broadcast-based LAN peer discovery.
 * Each desktop instance broadcasts its presence and listens for others.
 *
 * Uses UDP broadcast instead of mDNS to avoid native dependency.
 * Format: JSON message on UDP broadcast port.
 */
export class LANDiscovery {
  private options: Required<LANDiscoveryOptions>
  private peers = new Map<string, Peer & { lastSeen: number }>()
  private broadcastTimer: ReturnType<typeof setInterval> | null = null
  private socket: any = null
  private onPeerFound?: (peer: Peer) => void
  private onPeerLost?: (peer: Peer) => void

  constructor(options: LANDiscoveryOptions) {
    this.options = {
      broadcastPort: 41234,
      broadcastInterval: 5000,
      ...options,
    }
  }

  /**
   * Start advertising and discovering peers.
   */
  async start(callbacks?: {
    onPeerFound?: (peer: Peer) => void
    onPeerLost?: (peer: Peer) => void
  }): Promise<void> {
    this.onPeerFound = callbacks?.onPeerFound
    this.onPeerLost = callbacks?.onPeerLost

    // Use Bun's UDP socket
    const { broadcastPort } = this.options

    this.socket = await Bun.udpSocket({
      port: broadcastPort,
      socket: {
        data: (_socket, buf, port, addr) => {
          this.handleMessage(buf, addr)
        },
      },
    })

    // Start periodic broadcast
    this.broadcastTimer = setInterval(() => {
      this.broadcast()
      this.pruneStale()
    }, this.options.broadcastInterval)

    // Initial broadcast
    this.broadcast()
  }

  /**
   * Stop advertising and discovering.
   */
  stop(): void {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer)
      this.broadcastTimer = null
    }
    this.socket?.close()
    this.socket = null
  }

  /**
   * Get currently known peers.
   */
  getPeers(): Peer[] {
    return Array.from(this.peers.values()).map(({ lastSeen, ...peer }) => peer)
  }

  private broadcast(): void {
    if (!this.socket) return

    const msg = JSON.stringify({
      type: 'lgr-sync-announce',
      deviceId: this.options.deviceId,
      deviceName: this.options.deviceName,
      orgId: this.options.orgId,
      syncPort: this.options.syncPort,
    })

    const broadcastAddresses = this.getBroadcastAddresses()
    const data = Buffer.from(msg)

    for (const addr of broadcastAddresses) {
      try {
        this.socket.send(data, this.options.broadcastPort, addr)
      } catch {
        // Ignore send failures
      }
    }
  }

  private handleMessage(buf: Buffer, remoteAddr: string): void {
    try {
      const msg = JSON.parse(buf.toString())
      if (msg.type !== 'lgr-sync-announce') return
      if (msg.deviceId === this.options.deviceId) return // Ignore self
      if (msg.orgId !== this.options.orgId) return // Different org

      const peer: Peer = {
        address: `ws://${remoteAddr}:${msg.syncPort}`,
        port: msg.syncPort,
        name: msg.deviceName,
        deviceId: msg.deviceId,
        orgId: msg.orgId,
      }

      const isNew = !this.peers.has(msg.deviceId)
      this.peers.set(msg.deviceId, { ...peer, lastSeen: Date.now() })

      if (isNew) {
        this.onPeerFound?.(peer)
      }
    } catch {
      // Ignore malformed messages
    }
  }

  private pruneStale(): void {
    const staleThreshold = Date.now() - (this.options.broadcastInterval * 3)
    for (const [id, peer] of this.peers) {
      if (peer.lastSeen < staleThreshold) {
        this.peers.delete(id)
        const { lastSeen, ...p } = peer
        this.onPeerLost?.(p)
      }
    }
  }

  private getBroadcastAddresses(): string[] {
    const addresses: string[] = []
    const interfaces = networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]!) {
        if (iface.family === 'IPv4' && !iface.internal) {
          // Compute broadcast address from IP and netmask
          const ip = iface.address.split('.').map(Number)
          const mask = iface.netmask.split('.').map(Number)
          const broadcast = ip.map((octet, i) => (octet | (~mask[i] & 255))).join('.')
          addresses.push(broadcast)
        }
      }
    }
    return addresses.length > 0 ? addresses : ['255.255.255.255']
  }
}
