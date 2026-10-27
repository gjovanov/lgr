/**
 * Which socket carries a master's tunnel traffic on this process (FR-20.73, plan step P3-4b): its
 * interactive uplink, when that socket may (authenticated, no clone alarm, not outdated). The uplink
 * module answers it; the stream mux asks. A registry rather than an import, so neither module
 * imports the other.
 */
type Lookup = (nodeId: string) => any | null

let lookup: Lookup = () => null

export function setTunnelSocketLookup(f: Lookup): void {
  lookup = f
}

/** The node's interactive socket on this process, or null when it has none here that may tunnel. */
export function tunnelSocketOf(nodeId: string): any | null {
  return lookup(nodeId)
}
