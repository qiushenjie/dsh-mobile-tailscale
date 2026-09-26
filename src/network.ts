import { isIP } from 'node:net'

/** Whether an IP literal is loopback and therefore the local desktop surface. */
export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return address.startsWith('127.')
  if (family === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
    // Dual-stack sockets report IPv4 peers as `::ffff:127.0.0.1`.
    if (normalized.startsWith('::ffff:')) return isLoopbackAddress(normalized.slice('::ffff:'.length))
    return false
  }
  return false
}
