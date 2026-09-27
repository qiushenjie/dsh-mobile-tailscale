/**
 * Watching the app's WebSockets.
 *
 * A conversation's opening window is published by the `session/follow`
 * streaming RPC, which the app carries on its mux WebSocket. When that carrier
 * goes quiet nothing notices: the app waits for the opening frame forever and
 * the view sits on 「载入历史…」 with a perfectly healthy-looking HTTP history
 * request behind it. Measured against the live app: withholding only the
 * `session/follow` snapshot reproduces the stuck view exactly (0 turns, no
 * retry for 20 s, no server-side trace), and closing the socket makes the
 * connection layer rebuild its generation and publish the window again.
 *
 * So the plugin keeps a watch on every socket the page creates: frame counters,
 * the streams opened on it, and the ability to close them on demand.
 */

/** Sockets beyond this many are forgotten; only the newest ones matter. */
const MAX_WATCHED_SOCKETS = 32

/** Payloads longer than this are not parsed; their frames are counted only. */
const MAX_PARSED_PAYLOAD = 64 * 1024

/** The instance surface the watch needs, so a test double is enough. */
export interface WebSocketLike {
  readonly url: string
  readyState: number
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: Event) => void, options?: unknown): void
}

/** Constructor shape of the page's WebSocket. */
export interface WebSocketConstructor {
  new (url: string | URL, protocols?: string | string[]): WebSocketLike
}

/** Where the WebSocket lives, so a test double is enough. */
export interface SocketWatchTarget {
  WebSocket?: WebSocketConstructor
}

/** One socket's counters, as reported to telemetry. */
export interface SocketWatchRecord {
  url: string
  openedAt: number | null
  closedAt: number | null
  sent: number
  recv: number
  lastSentAt: number | null
  lastRecvAt: number | null
  /** Endpoints whose streams were opened on this socket. */
  endpoints: string[]
  /** `snapshot` frames seen on this socket: the opening windows it carried. */
  snapshots: number
  /** `session/follow` streams opened here. */
  followOpens: number
  /** Opening frames those streams published. */
  followSnapshots: number
}

/** Snapshot of every socket the watch has seen. */
export interface SocketWatchStats {
  installed: boolean
  sockets: number
  open: number
  sent: number
  recv: number
  lastRecvAt: number | null
  reconnects: number
  lastReconnectReason: string | null
  records: SocketWatchRecord[]
}

/** Injectable environment for the watch. */
export interface SocketWatchOptions {
  target?: SocketWatchTarget
  now?: () => number
}

const records: SocketWatchRecord[] = []
/**
 * Sockets of the installation in force. Kept per install, so a dispose cannot
 * leave a rebuilt page reconnecting sockets that belong to a dead one.
 */
let active: Set<WebSocketLike> | null = null
const watchStats = {
  installed: false,
  sent: 0,
  recv: 0,
  lastRecvAt: null as number | null,
  reconnects: 0,
  lastReconnectReason: null as string | null,
}

/**
 * Snapshot of the watch's counters and sockets.
 * @returns A copy, safe for a telemetry record.
 */
export function socketWatchStats(): SocketWatchStats {
  return {
    installed: watchStats.installed,
    sockets: records.length,
    open: active?.size ?? 0,
    sent: watchStats.sent,
    recv: watchStats.recv,
    lastRecvAt: watchStats.lastRecvAt,
    reconnects: watchStats.reconnects,
    lastReconnectReason: watchStats.lastReconnectReason,
    records: records.map(record => ({ ...record, endpoints: [...record.endpoints] })),
  }
}

/**
 * Whether any open socket opened `session/follow` without ever seeing its
 * opening frame — the measured cause of a view stuck on 「载入历史…」.
 *
 * A carrier the watch cannot describe reports false: a socket it does not own
 * is not one it should close.
 * @param stats - Snapshot from {@link socketWatchStats}.
 * @returns True when an opening window is known to be missing.
 */
export function openingWindowMissing(stats: SocketWatchStats | undefined): boolean {
  if (stats === undefined) return false
  return stats.records.some(record => record.closedAt === null && record.followOpens > record.followSnapshots)
}

/**
 * Close every socket the watch still sees open.
 *
 * The connection layer treats a closed carrier as a failed generation, rebuilds
 * it, and re-issues `session/follow` — which is what republishes a conversation
 * stuck on 「载入历史…」.
 * @param reason - Recorded with the counter, for telemetry.
 * @returns How many sockets were asked to close.
 */
export function reconnectSockets(reason = 'watch'): number {
  let closed = 0
  for (const socket of [...(active ?? [])]) {
    try {
      socket.close()
      closed += 1
    } catch {
      // A socket that refuses to close is already beyond this watch's reach.
    }
  }
  if (closed > 0) {
    watchStats.reconnects += 1
    watchStats.lastReconnectReason = reason
  }
  return closed
}

/**
 * Replace the page's WebSocket with one that reports every frame, once.
 *
 * Install this as early as the plugin module is evaluated: the app creates its
 * mux socket on connection activation, and a watch installed after that would
 * not own the socket this exists to close.
 * @param options - Injectable target and clock.
 * @returns A function that puts the original constructor back.
 */
export function installSocketWatch(options: SocketWatchOptions = {}): () => void {
  const target = options.target ?? (globalThis as SocketWatchTarget)
  const real = target.WebSocket
  if (typeof real !== 'function' || watchStats.installed) return () => undefined
  const Real: WebSocketConstructor = real
  const now = options.now ?? ((): number => Date.now())
  // The sockets this installation owns, and can therefore close again.
  const open = new Set<WebSocketLike>()

  class Watched extends Real {
    constructor(url: string | URL, protocols?: string | string[]) {
      try {
        super(url, protocols)
      } catch (error) {
        // Never let the watch break a connection it cannot classify.
        void error
        return Reflect.construct(Real, [url, protocols]) as unknown as Watched
      }
      try {
        const record: SocketWatchRecord = {
          url: String(url),
          openedAt: null,
          closedAt: null,
          sent: 0,
          recv: 0,
          lastSentAt: null,
          lastRecvAt: null,
          endpoints: [],
          snapshots: 0,
          followOpens: 0,
          followSnapshots: 0,
        }
        if (records.length >= MAX_WATCHED_SOCKETS) records.shift()
        records.push(record)
        open.add(this)

        /** Streams carrying `session/follow`, whose opening frame opens the view. */
        const followStreams = new Set<string>()

        const note = (kind: 'sent' | 'recv', data: unknown): void => {
          const at = now()
          if (kind === 'sent') {
            record.sent += 1
            record.lastSentAt = at
            watchStats.sent += 1
          } else {
            record.recv += 1
            record.lastRecvAt = at
            watchStats.recv += 1
            watchStats.lastRecvAt = at
          }
          if (typeof data !== 'string') return
          if (data.length > MAX_PARSED_PAYLOAD) {
            // The opening baseline is the one frame too big to parse: a history
            // snapshot. Count it, and attribute it by looking for the stream it
            // belongs to rather than decoding it.
            if (kind !== 'recv' || !data.includes('"snapshot"')) return
            record.snapshots += 1
            for (const streamId of followStreams) {
              if (data.includes(`"streamId":"${streamId}"`)) {
                record.followSnapshots += 1
                return
              }
            }
            return
          }
          let frame: unknown
          try {
            frame = JSON.parse(data)
          } catch {
            return
          }
          if (typeof frame !== 'object' || frame === null) return
          const endpoint = (frame as { endpoint?: unknown }).endpoint
          const type = (frame as { type?: unknown }).type
          const streamId = (frame as { streamId?: unknown }).streamId
          if (kind === 'sent' && type === 'open') {
            if (typeof endpoint === 'string' && !record.endpoints.includes(endpoint)) {
              record.endpoints.push(endpoint)
            }
            if (endpoint === 'session/follow' && typeof streamId === 'string') {
              followStreams.add(streamId)
              record.followOpens += 1
            }
            return
          }
          const value = (frame as { value?: unknown }).value
          if (kind === 'recv' && typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'snapshot') {
            record.snapshots += 1
            if (typeof streamId === 'string' && followStreams.has(streamId)) record.followSnapshots += 1
          }
        }

        const send = this.send.bind(this)
        this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView): void => {
          note('sent', data)
          send(data)
        }
        this.addEventListener('open', () => {
          record.openedAt = now()
        })
        this.addEventListener('message', event => {
          note('recv', (event as MessageEvent).data)
        })
        this.addEventListener('close', () => {
          record.closedAt = now()
          open.delete(this)
        })
      } catch {
        // Tracking is best effort; the socket itself must keep working.
      }
    }
  }

  target.WebSocket = Watched
  active = open
  watchStats.installed = true

  return () => {
    if (target.WebSocket === Watched) target.WebSocket = Real
    if (active === open) active = null
    watchStats.installed = false
  }
}
