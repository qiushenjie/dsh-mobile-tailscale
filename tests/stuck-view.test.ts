import { describe, expect, it } from 'vitest'

import type { SocketWatchRecord, SocketWatchStats } from '../src/socket-watch.js'
import {
  STUCK_VIEW_STORAGE_KEY,
  installStuckViewWatch,
  stuckHintOf,
  type StuckViewDocument,
  type StuckViewElement,
  type StuckViewRecord,
  type StuckViewStorage,
} from '../src/stuck-view.js'

/** A document whose nodes are whatever the test hands it. */
function fakeDocument(nodes: StuckViewElement[], visibilityState = 'visible'): StuckViewDocument {
  return {
    visibilityState,
    querySelectorAll: () => nodes,
  }
}

/** A document holding the host's placeholder. */
function stuckDocument(visibilityState = 'visible'): StuckViewDocument {
  return fakeDocument([{ childElementCount: 0, textContent: '载入历史…' }], visibilityState)
}

/** A document holding a rendered conversation. */
function openDocument(): StuckViewDocument {
  return fakeDocument([{ childElementCount: 2, textContent: '载入历史… ' }, { childElementCount: 0, textContent: '' }])
}

/** A clock the test moves. */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return { now: () => at, advance: (ms: number) => { at += ms } }
}

/** A scheduler the test drives tick by tick. */
function scheduler(): {
  setInterval: (callback: () => void, ms: number) => number
  clearInterval: (handle: number) => void
  tick: () => void
  cleared: number[]
  interval: number
} {
  let callback: (() => void) | null = null
  const cleared: number[] = []
  const state = {
    interval: 0,
    cleared,
    setInterval: (next: () => void, ms: number): number => {
      callback = next
      state.interval = ms
      return 7
    },
    clearInterval: (handle: number): void => {
      cleared.push(handle)
    },
    tick: (): void => callback?.(),
  }
  return state
}

/** In-memory storage for the reload limit. */
function memoryStorage(seed?: number[]): StuckViewStorage & { value: string | null } {
  const store: StuckViewStorage & { value: string | null } = {
    value: seed === undefined ? null : JSON.stringify(seed),
    getItem: () => store.value,
    setItem: (_key: string, next: string) => {
      store.value = next
    },
  }
  return store
}

/** One socket record, as the watch reports it. */
function socketRecord(overrides: Partial<SocketWatchRecord> = {}): SocketWatchRecord {
  return {
    url: 'wss://example.invalid/api/remote.mux',
    openedAt: 0,
    closedAt: null,
    sent: 5,
    recv: 4,
    lastSentAt: 0,
    lastRecvAt: 0,
    endpoints: ['session/follow', 'job/list'],
    snapshots: 4,
    followOpens: 1,
    followSnapshots: 0,
    ...overrides,
  }
}

/** Socket stats for a carrier whose opening window never arrived. */
function stalledSockets(overrides: Partial<SocketWatchStats> = {}): SocketWatchStats {
  return {
    installed: true,
    sockets: 1,
    open: 1,
    sent: 5,
    recv: 4,
    lastRecvAt: 0,
    reconnects: 0,
    lastReconnectReason: null,
    records: [socketRecord()],
    ...overrides,
  }
}

/** Collects telemetry and reloads. */
function harness(options: {
  document?: StuckViewDocument
  delayMs?: number
  recoveryMs?: number
  reconnect?: () => number
  sockets?: () => SocketWatchStats | undefined
  storage?: StuckViewStorage
  turns?: number
}) {
  const time = clock()
  const timers = scheduler()
  const records: StuckViewRecord[] = []
  let reloads = 0
  const started = installStuckViewWatch({
    document: options.document ?? stuckDocument(),
    now: time.now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    send: (_endpoint, payload) => {
      records.push(JSON.parse(payload) as StuckViewRecord)
    },
    sockets: options.sockets ?? (() => stalledSockets()),
    pageStats: () => undefined,
    reconnect: options.reconnect ?? (() => 1),
    turns: () => options.turns ?? 0,
    storage: options.storage ?? memoryStorage(),
    location: { reload: () => { reloads += 1 } },
    delayMs: options.delayMs ?? 3_000,
    recoveryMs: options.recoveryMs ?? 6_000,
    online: () => true,
  })
  const phases = (): string[] => records.map(record => record.phase)
  return { time, timers, records, phases, started, reloads: () => reloads }
}

describe('stuckHintOf', () => {
  it('finds the host placeholder on a leaf element', () => {
    expect(stuckHintOf(stuckDocument())).toBe('载入历史…')
  })

  it('matches the English string regardless of case', () => {
    expect(stuckHintOf(fakeDocument([{ childElementCount: 0, textContent: 'Loading history…' }]))).toBe('Loading history…')
  })

  it('ignores a container that merely holds the placeholder', () => {
    expect(stuckHintOf(fakeDocument([{ childElementCount: 1, textContent: '载入历史…' }]))).toBeNull()
  })

  it('ignores unrelated and oversized text', () => {
    expect(stuckHintOf(fakeDocument([{ childElementCount: 0, textContent: '载入历史的讨论内容非常多，这不是占位符'.repeat(4) }]))).toBeNull()
    expect(stuckHintOf(fakeDocument([{ childElementCount: 0, textContent: '会话已就绪' }, {}]))).toBeNull()
  })
})

describe('installStuckViewWatch', () => {
  it('polls on the configured interval', () => {
    const test = harness({})
    expect(test.timers.interval).toBe(1_000)
    test.started()
    expect(test.timers.cleared).toEqual([7])
  })

  it('waits for the hint to persist, then reports a detection', () => {
    const test = harness({})
    test.timers.tick()
    expect(test.records).toEqual([])
    test.time.advance(2_999)
    test.timers.tick()
    expect(test.records).toEqual([])
    test.time.advance(1)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect'])
    expect(test.records[0]).toMatchObject({
      kind: 'stuck-view',
      phase: 'detected',
      stuckMs: 3_000,
      hint: '载入历史…',
      turns: 0,
      hidden: false,
      online: true,
      sockets: { installed: true, open: 1, records: [{ followOpens: 1, followSnapshots: 0 }] },
      pageFetch: null,
    })
    expect(Number.isNaN(Date.parse(test.records[0]?.at ?? ''))).toBe(false)
  })

  it('leaves a carrier that never opened the window alone', () => {
    const test = harness({ sockets: () => undefined })
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected'])
    test.time.advance(5_999)
    test.timers.tick()
    expect(test.reloads()).toBe(0)
    test.time.advance(1)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reload'])
    expect(test.reloads()).toBe(1)
  })

  it('does not close a carrier whose opening window arrived', () => {
    const test = harness({ sockets: () => stalledSockets({ records: [socketRecord({ followSnapshots: 1 })] }) })
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected'])
    test.time.advance(6_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reload'])
  })

  it('does not close a socket that already died with the window missing', () => {
    const test = harness({ sockets: () => stalledSockets({ open: 0, records: [socketRecord({ closedAt: 1_000 })] }) })
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected'])
  })

  it('rebuilds the carrier before it reloads anything', () => {
    const test = harness({})
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect'])
    expect(test.reloads()).toBe(0)
  })

  it('reloads when there is no socket to rebuild', () => {
    const test = harness({ reconnect: () => 0 })
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect', 'reload'])
    expect(test.reloads()).toBe(1)
  })

  it('gives a rebuilt carrier time to republish before reloading', () => {
    const test = harness({})
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    test.time.advance(5_999)
    test.timers.tick()
    expect(test.reloads()).toBe(0)
    test.time.advance(1)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect', 'reload'])
    expect(test.reloads()).toBe(1)
  })

  it('reports the recovery and can watch a second episode', () => {
    const nodes: StuckViewElement[] = [{ childElementCount: 0, textContent: '载入历史…' }]
    const test = harness({ document: { visibilityState: 'visible', querySelectorAll: () => nodes } })
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    test.time.advance(4_000)
    nodes.splice(0, nodes.length, { childElementCount: 0, textContent: '第 1 轮' })
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect', 'recovered'])
    expect(test.records.at(-1)).toMatchObject({ phase: 'recovered', hint: null, turns: 0, stuckMs: 7_000 })

    nodes.splice(0, nodes.length, { childElementCount: 0, textContent: '载入历史…' })
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect', 'recovered', 'detected', 'reconnect'])
  })

  it('stops reloading once the limit is spent inside the window', () => {
    const storage = memoryStorage([1_000, 2_000, 2_500])
    const test = harness({ reconnect: () => 0, storage })
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect', 'gave-up'])
    expect(test.reloads()).toBe(0)
  })

  it('forgets reloads older than the window', () => {
    const test = harness({ reconnect: () => 0, storage: memoryStorage([1_000, 2_000, 2_500]) })
    test.time.advance(400_000)
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect', 'reload'])
    expect(test.reloads()).toBe(1)
  })

  it('records the reload in storage so the limit survives the reload', () => {
    const storage = memoryStorage()
    const test = harness({ reconnect: () => 0, storage })
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    expect(JSON.parse(storage.value ?? '[]')).toEqual([3_000])
  })

  it('ignores a hidden document', () => {
    const test = harness({ document: stuckDocument('hidden') })
    test.timers.tick()
    test.time.advance(30_000)
    test.timers.tick()
    expect(test.records).toEqual([])
    expect(test.reloads()).toBe(0)
  })

  it('does not report a view that opened', () => {
    const test = harness({ document: openDocument() })
    test.timers.tick()
    test.time.advance(30_000)
    test.timers.tick()
    expect(test.records).toEqual([])
  })

  it('keeps watching when storage refuses to be read', () => {
    const storage: StuckViewStorage = {
      getItem: () => {
        throw new Error('private mode')
      },
      setItem: () => undefined,
    }
    const test = harness({ reconnect: () => 0, storage })
    test.timers.tick()
    test.time.advance(3_000)
    test.timers.tick()
    expect(test.reloads()).toBe(1)
  })

  it('does nothing without a document', () => {
    const dispose = installStuckViewWatch({ setInterval: () => 1, clearInterval: () => undefined })
    expect(typeof dispose).toBe('function')
    dispose()
  })
})

describe('storage key', () => {
  it('is namespaced to the plugin', () => {
    expect(STUCK_VIEW_STORAGE_KEY).toBe('dsh-mobile.stuck-view.reloads')
  })
})
