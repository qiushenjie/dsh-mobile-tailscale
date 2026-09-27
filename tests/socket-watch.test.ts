import { describe, expect, it } from 'vitest'

import {
  installSocketWatch,
  openingWindowMissing,
  reconnectSockets,
  socketWatchStats,
  type SocketWatchStats,
  type WebSocketConstructor,
} from '../src/socket-watch.js'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  readonly sent: unknown[] = []
  closes = 0
  closeThrows = false
  private readonly listeners = new Map<string, ((event: Event) => void)[]>()

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url)
    void protocols
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(data)
  }

  close(): void {
    this.closes += 1
    if (this.closeThrows) throw new Error('close refused')
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close')
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as unknown as Event)
  }
}

/** A fresh target, so each test owns its constructor. */
function target(): { WebSocket?: WebSocketConstructor } {
  return { WebSocket: FakeWebSocket as unknown as WebSocketConstructor }
}

/** Counters relative to now, because the watch's counters are process-wide. */
function delta(before: SocketWatchStats, after: SocketWatchStats): Record<string, number> {
  return {
    sockets: after.sockets - before.sockets,
    sent: after.sent - before.sent,
    recv: after.recv - before.recv,
    reconnects: after.reconnects - before.reconnects,
  }
}

describe('installSocketWatch', () => {
  it('counts frames and keeps the streams opened on each socket', () => {
    const host = target()
    let at = 1_000
    const dispose = installSocketWatch({ target: host, now: () => at })
    const before = socketWatchStats()

    const socket = new (host.WebSocket as unknown as typeof FakeWebSocket)('wss://host/api/remote.mux')
    expect(socketWatchStats().installed).toBe(true)
    socket.emit('open')
    at = 1_010
    socket.send(JSON.stringify({ type: 'open', endpoint: 'session/follow', streamId: 'a' }))
    at = 1_020
    socket.send(JSON.stringify({ type: 'open', endpoint: 'session/control', streamId: 'b' }))
    at = 1_030
    socket.emit('message', JSON.stringify({ type: 'item', streamId: 'a', value: { type: 'snapshot' } }))
    at = 1_040
    socket.emit('message', '{"type":"notification"}')

    const after = socketWatchStats()
    expect(delta(before, after)).toMatchObject({ sockets: 1, sent: 2, recv: 2 })
    const record = after.records.at(-1)
    expect(record).toMatchObject({
      url: 'wss://host/api/remote.mux',
      openedAt: 1_000,
      closedAt: null,
      sent: 2,
      recv: 2,
      lastSentAt: 1_020,
      lastRecvAt: 1_040,
      endpoints: ['session/follow', 'session/control'],
      snapshots: 1,
      followOpens: 1,
      followSnapshots: 1,
    })
    expect(after.open).toBeGreaterThan(0)
    expect(after.lastRecvAt).toBe(1_040)
    dispose()
    expect(socketWatchStats().installed).toBe(false)
  })

  it('counts a snapshot too large to parse, and a sent snapshot does not count', () => {
    const host = target()
    const dispose = installSocketWatch({ target: host })
    const before = socketWatchStats()
    const socket = new (host.WebSocket as unknown as typeof FakeWebSocket)('wss://host/api/remote.mux')
    const huge = `{"type":"item","value":{"type":"snapshot","records":["${'x'.repeat(100_000)}"]}}`

    socket.send(JSON.stringify({ type: 'open', endpoint: 'session/follow' }))
    socket.send(huge)
    socket.emit('message', huge)
    socket.emit('message', `{"type":"item","value":{"type":"entry","text":"${'y'.repeat(100_000)}"}}`)

    const record = socketWatchStats().records.at(-1)
    expect(delta(before, socketWatchStats())).toMatchObject({ sent: 2, recv: 2 })
    expect(record?.snapshots).toBe(1)
    dispose()
  })

  it('survives payloads it cannot read', () => {
    const host = target()
    const dispose = installSocketWatch({ target: host })
    const socket = new (host.WebSocket as unknown as typeof FakeWebSocket)('wss://host/api/remote.mux')

    socket.send('not json')
    socket.send(JSON.stringify({ type: 'open' }))
    socket.send(JSON.stringify({ type: 'open', endpoint: 7 }))
    socket.emit('message', undefined)
    socket.emit('message', JSON.stringify(['open', 'session/follow']))

    const record = socketWatchStats().records.at(-1)
    expect(record?.sent).toBe(3)
    expect(record?.recv).toBe(2)
    expect(record?.endpoints).toEqual([])
    dispose()
  })

  it('closes open sockets on demand and counts the reconnect', () => {
    const host = target()
    const dispose = installSocketWatch({ target: host })
    const before = socketWatchStats()
    const first = new (host.WebSocket as unknown as typeof FakeWebSocket)('wss://host/api/remote.mux')
    const second = new (host.WebSocket as unknown as typeof FakeWebSocket)('wss://host/api/remote.mux')
    first.emit('open')
    second.emit('open')
    second.close()

    const closed = reconnectSockets('stuck-view')

    expect(closed).toBe(1)
    expect(first.closes).toBe(1)
    expect(first.readyState).toBe(FakeWebSocket.CLOSED)
    const after = socketWatchStats()
    expect(delta(before, after).reconnects).toBe(1)
    expect(after.lastReconnectReason).toBe('stuck-view')
    dispose()
  })

  it('keeps going when one socket refuses to close', () => {
    const host = target()
    const dispose = installSocketWatch({ target: host })
    const before = socketWatchStats()
    const broken = new (host.WebSocket as unknown as typeof FakeWebSocket)('wss://host/a')
    const healthy = new (host.WebSocket as unknown as typeof FakeWebSocket)('wss://host/b')
    broken.closeThrows = true

    expect(reconnectSockets()).toBe(1)
    expect(healthy.closes).toBe(1)
    expect(delta(before, socketWatchStats()).reconnects).toBe(1)
    dispose()
  })

  it('installs once and restores the original constructor', () => {
    const host = target()
    const dispose = installSocketWatch({ target: host })
    const wrapped = host.WebSocket
    const again = installSocketWatch({ target: host })

    expect(host.WebSocket).toBe(wrapped)
    expect(socketWatchStats().installed).toBe(true)
    again()
    expect(socketWatchStats().installed).toBe(true)

    dispose()
    expect(host.WebSocket).toBe(FakeWebSocket)
    expect(socketWatchStats().installed).toBe(false)
  })

  it('does nothing without a WebSocket to wrap', () => {
    const host: { WebSocket?: WebSocketConstructor } = {}
    const dispose = installSocketWatch({ target: host })
    expect(socketWatchStats().installed).toBe(false)
    expect(host.WebSocket).toBeUndefined()
    dispose()
  })

  it('forgets the oldest sockets once the cap is reached', () => {
    const host = target()
    const dispose = installSocketWatch({ target: host })
    for (let index = 0; index < 40; index += 1) {
      const socket = new (host.WebSocket as unknown as typeof FakeWebSocket)(`wss://host/${index}`)
      socket.emit('open')
    }
    const after = socketWatchStats()
    expect(after.records.at(-1)?.url).toBe('wss://host/39')
    expect(after.records.length).toBeLessThanOrEqual(32)
    dispose()
  })
})

describe('openingWindowMissing', () => {
  it('follows one stream from its open to its opening frame', () => {
    const host = target()
    const dispose = installSocketWatch({ target: host })
    const socket = new (host.WebSocket as unknown as typeof FakeWebSocket)('wss://host/api/remote.mux')

    expect(openingWindowMissing(undefined)).toBe(false)
    expect(openingWindowMissing({ ...socketWatchStats(), records: [] })).toBe(false)

    socket.send(JSON.stringify({ type: 'open', endpoint: 'session/follow', streamId: 'a' }))
    expect(openingWindowMissing(socketWatchStats())).toBe(true)

    socket.emit('message', JSON.stringify({ type: 'item', streamId: 'a', value: { type: 'snapshot' } }))
    expect(openingWindowMissing(socketWatchStats())).toBe(false)

    socket.send(JSON.stringify({ type: 'open', endpoint: 'session/follow', streamId: 'b' }))
    expect(openingWindowMissing(socketWatchStats())).toBe(true)

    socket.send(JSON.stringify({ type: 'open', endpoint: 'session/page', streamId: 'c' }))
    expect(openingWindowMissing(socketWatchStats())).toBe(true)

    socket.emit('message', JSON.stringify({ type: 'item', streamId: 'b', value: { type: 'snapshot' } }))
    expect(openingWindowMissing(socketWatchStats())).toBe(false)
    dispose()
  })

  it('attributes an opening frame too large to parse to its stream', () => {
    const host = target()
    const dispose = installSocketWatch({ target: host })
    const socket = new (host.WebSocket as unknown as typeof FakeWebSocket)('wss://host/api/remote.mux')
    socket.send(JSON.stringify({ type: 'open', endpoint: 'session/follow', streamId: 'a' }))

    socket.emit('message', `{"type":"item","streamId":"a","value":{"type":"snapshot","records":["${'x'.repeat(100_000)}"]}}`)
    expect(socketWatchStats().records.at(-1)?.followSnapshots).toBe(1)
    expect(openingWindowMissing(socketWatchStats())).toBe(false)

    socket.send(JSON.stringify({ type: 'open', endpoint: 'session/follow', streamId: 'b' }))
    socket.emit('message', `{"type":"item","streamId":"b","value":{"type":"snapshot","records":["${'x'.repeat(100_000)}"]}}`)
    socket.emit('message', `{"type":"item","streamId":"a","value":{"type":"entry","text":"${'x'.repeat(100_000)}"}}`)
    expect(openingWindowMissing(socketWatchStats())).toBe(false)
    dispose()
  })

  it('forgets a window that was missing on a socket that already died', () => {
    const host = target()
    const dispose = installSocketWatch({ target: host })
    const socket = new (host.WebSocket as unknown as typeof FakeWebSocket)('wss://host/api/remote.mux')
    socket.send(JSON.stringify({ type: 'open', endpoint: 'session/follow', streamId: 'a' }))
    expect(openingWindowMissing(socketWatchStats())).toBe(true)

    socket.close()
    expect(openingWindowMissing(socketWatchStats())).toBe(false)
    dispose()
  })
})
