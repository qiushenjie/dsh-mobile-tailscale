import { describe, expect, it } from 'vitest'

import type { SocketWatchRecord, SocketWatchStats } from '../src/socket-watch.js'
import {
  STUCK_VIEW_STORAGE_KEY,
  installStuckViewWatch,
  isPlaceholderText,
  stuckHintOf,
  type StuckViewDocument,
  type StuckViewElement,
  type StuckViewRecord,
  type StuckViewStorage,
} from '../src/stuck-view.js'

/** The class the host's CSS module puts on its loading hint. */
const HINT_CLASS = '_hint_1ionb_41'

/** A leaf carrying the host's placeholder. */
function hintNode(text = '载入历史…'): StuckViewElement {
  return { childElementCount: 0, textContent: text, className: HINT_CLASS }
}

/** A document that answers the hint and turn selectors separately. */
function fakeDocument(options: {
  hint?: StuckViewElement | null
  turns?: number
  visibilityState?: string
} = {}): StuckViewDocument {
  const hint = options.hint === undefined ? hintNode() : options.hint
  const count = options.turns ?? 0
  return {
    visibilityState: options.visibilityState ?? 'visible',
    querySelectorAll: (selector: string): ArrayLike<StuckViewElement> => {
      if (selector.includes('data-chat-turn')) {
        return Array.from({ length: count }, () => ({ childElementCount: 0, textContent: '' }))
      }
      return hint === null ? [] : [hint]
    },
  }
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
  reconnectBackoff?: number
  maxReconnects?: number
  reloadAfterMs?: number
  reconnect?: () => number
  sockets?: () => SocketWatchStats | undefined
  stalled?: () => boolean
  storage?: StuckViewStorage
  turns?: number | (() => number)
  online?: boolean
}) {
  const time = clock()
  const timers = scheduler()
  const records: StuckViewRecord[] = []
  let reloads = 0
  const started = installStuckViewWatch({
    document: options.document ?? fakeDocument(),
    now: time.now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    send: (_endpoint, payload) => {
      records.push(JSON.parse(payload) as StuckViewRecord)
    },
    sockets: options.sockets ?? (() => stalledSockets()),
    pageStats: () => undefined,
    reconnect: options.reconnect ?? (() => 1),
    turns: () => (typeof options.turns === 'function' ? options.turns() : options.turns ?? 0),
    storage: options.storage ?? memoryStorage(),
    location: { reload: () => { reloads += 1 } },
    delayMs: options.delayMs ?? 2_000,
    reconnectBackoff: options.reconnectBackoff ?? 2,
    maxReconnects: options.maxReconnects ?? 3,
    reloadAfterMs: options.reloadAfterMs ?? 30_000,
    ...(options.stalled === undefined ? {} : { stalled: options.stalled }),
    online: () => options.online ?? true,
  })
  const phases = (): string[] => records.map(record => record.phase)
  return { time, timers, records, phases, started, reloads: () => reloads }
}

describe('stuckHintOf', () => {
  it('finds the host placeholder on its own hint element', () => {
    expect(stuckHintOf(fakeDocument())).toBe('载入历史…')
  })

  it('matches the English string', () => {
    expect(stuckHintOf(fakeDocument({ hint: hintNode('Loading history…') }))).toBe('Loading history…')
  })

  it('ignores conversation text that merely mentions the placeholder', () => {
    const message: StuckViewElement = { childElementCount: 0, textContent: '「载入历史…」修复已上线', className: '_message_1a2b3_9' }
    expect(stuckHintOf(fakeDocument({ hint: message }))).toBeNull()
  })

  it('ignores a container that merely holds the placeholder', () => {
    const container: StuckViewElement = { childElementCount: 1, textContent: '载入历史…', className: HINT_CLASS }
    expect(stuckHintOf(fakeDocument({ hint: container }))).toBeNull()
  })

  it('ignores an unrelated hint element and an empty document', () => {
    const other: StuckViewElement = { childElementCount: 0, textContent: '会话已就绪', className: '_notice_4d5e6_2' }
    expect(stuckHintOf(fakeDocument({ hint: other }))).toBeNull()
    expect(stuckHintOf(fakeDocument({ hint: null }))).toBeNull()
  })

  it('ignores hint text too long to be the placeholder', () => {
    const long: StuckViewElement = { childElementCount: 0, textContent: '载入历史是什么以及为什么会卡住'.repeat(3), className: HINT_CLASS }
    expect(stuckHintOf(fakeDocument({ hint: long }))).toBeNull()
  })
})

describe('isPlaceholderText', () => {
  it('recognizes the host strings only', () => {
    expect(isPlaceholderText('载入历史…')).toBe(true)
    expect(isPlaceholderText(' Loading History… ')).toBe(true)
    expect(isPlaceholderText('「载入历史…」修复已上线')).toBe(false)
  })
})

describe('installStuckViewWatch', () => {
  it('polls on the configured interval and stops on dispose', () => {
    const test = harness({})
    expect(test.timers.interval).toBe(500)
    test.started()
    expect(test.timers.cleared).toEqual([7])
  })

  it('waits for the placeholder to persist, then reports and rebuilds at once', () => {
    const test = harness({})
    test.timers.tick()
    expect(test.records).toEqual([])
    test.time.advance(1_999)
    test.timers.tick()
    expect(test.records).toEqual([])
    test.time.advance(1)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect'])
    expect(test.records[0]).toMatchObject({
      kind: 'stuck-view',
      phase: 'detected',
      stuckMs: 2_000,
      hint: '载入历史…',
      turns: 0,
      hidden: false,
      online: true,
      stalled: true,
      sockets: { installed: true, open: 1, records: [{ followOpens: 1, followSnapshots: 0 }] },
      pageFetch: null,
    })
    expect(test.records[1]).toMatchObject({ phase: 'reconnect', attempt: 1, closed: 1, stuckMs: 2_000 })
    expect(Number.isNaN(Date.parse(test.records[0]?.at ?? ''))).toBe(false)
    expect(test.reloads()).toBe(0)
  })

  it('backs off between rebuilds: two seconds, then six, then fourteen', () => {
    const test = harness({})
    test.timers.tick()
    test.time.advance(2_000)
    test.timers.tick()
    expect(test.records.map(record => [record.phase, record.stuckMs])).toEqual([['detected', 2_000], ['reconnect', 2_000]])
    test.time.advance(3_999)
    test.timers.tick()
    expect(test.records.filter(record => record.phase === 'reconnect')).toHaveLength(1)
    test.time.advance(1)
    test.timers.tick()
    expect(test.records.at(-1)).toMatchObject({ phase: 'reconnect', attempt: 2, stuckMs: 6_000 })
    test.time.advance(7_999)
    test.timers.tick()
    expect(test.records.filter(record => record.phase === 'reconnect')).toHaveLength(2)
    test.time.advance(1)
    test.timers.tick()
    expect(test.records.at(-1)).toMatchObject({ phase: 'reconnect', attempt: 3, stuckMs: 14_000 })
    expect(test.reloads()).toBe(0)
  })

  it('stops rebuilding and reloads thirty seconds into the stall', () => {
    const test = harness({})
    test.timers.tick()
    test.time.advance(2_000)
    test.timers.tick()
    test.time.advance(4_000)
    test.timers.tick()
    test.time.advance(8_000)
    test.timers.tick()
    expect(test.reloads()).toBe(0)
    test.time.advance(16_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect', 'reconnect', 'reconnect', 'reload'])
    expect(test.reloads()).toBe(1)
  })

  it('reloads at once when there is no socket to rebuild', () => {
    const test = harness({ reconnect: () => 0 })
    test.timers.tick()
    test.time.advance(2_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect', 'reload'])
    expect(test.reloads()).toBe(1)
  })

  it('never touches a view that is showing turns', () => {
    const test = harness({ turns: 28 })
    test.timers.tick()
    test.time.advance(120_000)
    test.timers.tick()
    expect(test.records).toEqual([])
    expect(test.reloads()).toBe(0)
  })

  it('never acts on a healthy conversation that mentions the placeholder', () => {
    const message: StuckViewElement = { childElementCount: 0, textContent: '「载入历史…」修复已上线', className: '_message_1a2b3_9' }
    const test = harness({ document: fakeDocument({ hint: message, turns: 28 }) })
    test.timers.tick()
    test.time.advance(120_000)
    test.timers.tick()
    expect(test.records).toEqual([])
    expect(test.reloads()).toBe(0)
  })

  it('never acts while the page is hidden', () => {
    const test = harness({ document: fakeDocument({ visibilityState: 'hidden' }) })
    test.timers.tick()
    test.time.advance(600_000)
    test.timers.tick()
    expect(test.records).toEqual([])
    expect(test.reloads()).toBe(0)
  })

  it('waits out an offline phone instead of rebuilding or reloading', () => {
    const test = harness({ online: false })
    test.timers.tick()
    test.time.advance(120_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected'])
    expect(test.reloads()).toBe(0)
  })

  it('reports the recovery and keeps watching', () => {
    let turns = 0
    const nodes: StuckViewElement[] = [hintNode()]
    const document: StuckViewDocument = {
      visibilityState: 'visible',
      querySelectorAll: (selector: string): ArrayLike<StuckViewElement> => selector.includes('data-chat-turn')
        ? Array.from({ length: turns }, () => ({ childElementCount: 0, textContent: '' }))
        : nodes,
    }
    const test = harness({ document, turns: () => turns })
    test.timers.tick()
    test.time.advance(20_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect'])
    turns = 46
    nodes.splice(0, nodes.length)
    test.time.advance(1_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect', 'recovered'])
    expect(test.records.at(-1)).toMatchObject({ phase: 'recovered', hint: null, turns: 46, stuckMs: 21_000 })
  })

  it('notes when the empty view has no stalled carrier to blame', () => {
    const test = harness({ sockets: () => stalledSockets({ records: [socketRecord({ followSnapshots: 1 })] }) })
    test.timers.tick()
    test.time.advance(5_000)
    test.timers.tick()
    expect(test.records[0]).toMatchObject({ phase: 'detected', stalled: false })
    expect(test.records[0]?.sockets?.installed).toBe(true)
  })

  it('stops reloading once the limit is spent inside the window', () => {
    const storage = memoryStorage([1_000, 2_000])
    const test = harness({ reconnect: () => 0, storage })
    test.timers.tick()
    test.time.advance(15_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect', 'gave-up'])
    expect(test.reloads()).toBe(0)
  })

  it('forgets reloads older than the window', () => {
    const test = harness({ reconnect: () => 0, storage: memoryStorage([1_000, 2_000]) })
    test.time.advance(700_000)
    test.timers.tick()
    test.time.advance(15_000)
    test.timers.tick()
    expect(test.phases()).toEqual(['detected', 'reconnect', 'reload'])
    expect(test.reloads()).toBe(1)
  })

  it('records the reload in storage so the limit survives the reload', () => {
    const storage = memoryStorage()
    const test = harness({ reconnect: () => 0, storage })
    test.timers.tick()
    test.time.advance(15_000)
    test.timers.tick()
    expect(JSON.parse(storage.value ?? '[]')).toEqual([15_000])
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
    test.time.advance(15_000)
    test.timers.tick()
    expect(test.reloads()).toBe(1)
  })

  it('leaves a merely slow open alone', () => {
    const nodes: StuckViewElement[] = [hintNode()]
    const document: StuckViewDocument = {
      visibilityState: 'visible',
      querySelectorAll: (selector: string): ArrayLike<StuckViewElement> => selector.includes('data-chat-turn') ? [] : nodes,
    }
    const test = harness({ document })
    test.timers.tick()
    test.time.advance(1_500)
    test.timers.tick()
    // The window arrives before the two second mark: nothing was rebuilt.
    nodes.splice(0, nodes.length)
    test.time.advance(500)
    test.timers.tick()
    expect(test.records).toEqual([])
    expect(test.reloads()).toBe(0)
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
