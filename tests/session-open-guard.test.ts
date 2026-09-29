import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  installSessionOpenGuard,
  SESSION_OPEN_GUARD_HOLD_MAX_MS,
  SESSION_OPEN_GUARD_NO_FRAME_MS,
  type SessionOpenRecord,
} from '../src/session-open-guard.js'

/**
 * The app's session class, as far as the guard meets it: `open()` caches the
 * pass in `openPromise` and clears it in its own `.finally`, which is exactly
 * what makes the strand permanent.
 */
class FakeSession {
  sessionId: string
  openState: unknown = 'cold'
  openPromise: unknown = null
  removed = false
  address: { mode?: unknown } | undefined = { mode: 'direct' }
  opens = 0
  resyncs = 0
  disposals = 0
  /** Reproduce the app's stale return: settle without ever publishing `open`. */
  stranded = false
  /** Reproduce a first frame that never arrives: never settle the pass. */
  pending = false
  release: (() => void) | undefined

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  open(): Promise<void> {
    this.opens += 1
    if (this.openState === 'open') return Promise.resolve()
    if (this.openPromise !== null) return this.openPromise as Promise<void>
    const promise = this.doOpen().finally(() => {
      if (this.openPromise === promise) this.openPromise = null
    })
    this.openPromise = promise
    return promise
  }

  async doOpen(): Promise<void> {
    this.openState = 'loading'
    if (this.pending) await new Promise<void>((resolve) => { this.release = resolve })
    if (this.stranded) return
    this.openState = 'open'
  }

  async resync(): Promise<void> {
    this.resyncs += 1
    this.openState = 'cold'
    this.openPromise = null
    await this.open()
  }

  async dispose(): Promise<void> {
    this.disposals += 1
  }
}

interface Harness {
  readonly session: FakeSession
  readonly service: () => unknown
  readonly rows: SessionOpenRecord[]
  readonly stop: () => void
  /** The manager's id-to-instance map, as the app hands it out and drops from it. */
  readonly live: Map<string, FakeSession>
  /** The session ids the guard asked the app's navigation to re-open. */
  readonly asked: string[]
  /** The session ids the phone took a reference to. */
  readonly holds: string[]
  /** Why each held reference was given back, in order. */
  readonly handbacks: string[]
}

/**
 * A fresh subclass per harness: the guard marks and wraps one prototype per
 * page load, so tests must not share it (a mark from an earlier test would
 * leave that test's wrappers — and its telemetry — in charge).
 */
function newSession(id = 'session-1'): FakeSession {
  const Fresh = class extends FakeSession {}
  return new Fresh(id)
}

interface HarnessOptions {
  /** Whether the app's navigation accepts the re-open; it always gets asked. */
  reopenAccepted?: boolean
  maxReselects?: number
  /** Whether this harness lends the guard a session-holding callback. */
  hold?: boolean
  /** Whether the phone ends up as the only holder, as the device's strand does. */
  soleHolder?: () => boolean
  /** The reference rows the app publishes for the session, when it publishes any. */
  retention?: { referenceCount: number; retainedBy: Record<string, number> }
}

function harness(
  shape: 'session' | 'empty' | 'array' | 'none' = 'session',
  held?: FakeSession,
  options: HarnessOptions = {},
): Harness {
  const session = held ?? newSession()
  const rows: SessionOpenRecord[] = []
  const asked: string[] = []
  const holds: string[] = []
  const handbacks: string[] = []
  const holding = new Set<string>()
  const live = new Map<string, FakeSession>([[session.sessionId, session]])
  const service = (): unknown => {
    if (shape === 'session') {
      return {
        manager: { sessions: live },
        ...(options.retention === undefined ? {} : { retentionSnapshot: () => options.retention }),
      }
    }
    if (shape === 'empty') return { manager: { sessions: new Map() } }
    if (shape === 'array') return { manager: { sessions: [] } }
    return undefined
  }
  const stop = installSessionOpenGuard({
    sessions: service,
    endpoint: '/__dsh-mobile/telemetry',
    reopenSession: (sessionId) => {
      asked.push(sessionId)
      return options.reopenAccepted ?? true
    },
    ...(options.hold === true
      ? {
          holdSession: (sessionId: string) => {
            holds.push(sessionId)
            holding.add(sessionId)
            return {
              sessionId,
              soleHolder: () => options.soleHolder?.() ?? false,
              release: (reason: string): void => {
                if (!holding.delete(sessionId)) return
                handbacks.push(reason)
              },
            }
          },
        }
      : {}),
    ...(options.maxReselects === undefined ? {} : { maxReselects: options.maxReselects }),
    send: (_endpoint, payload) => { rows.push(JSON.parse(payload) as SessionOpenRecord) },
  })
  return { session, service, rows, stop, live, asked, holds, handbacks }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('installSessionOpenGuard', () => {
  it('leaves a healthy open alone', async () => {
    const { session, rows, stop } = harness()
    await session.open()
    await vi.advanceTimersByTimeAsync(50)
    expect(session.openState).toBe('open')
    expect(session.opens).toBe(1)
    expect(rows).toEqual([])
    stop()
  })

  it('opens a session again when the app let the pass go stale', async () => {
    const { session, rows, stop } = harness()
    session.stranded = true
    const pass = session.open()
    // The app's own `open()` settled without publishing anything: repair it.
    session.stranded = false
    await pass
    await vi.advanceTimersByTimeAsync(0)
    expect(session.openPromise).toBe(null)
    expect(session.opens).toBe(2)
    expect(session.openState).toBe('open')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'session-open', phase: 'stranded', sessionId: 'session-1', repairs: 1 })
    expect(rows[0]?.mode).toBe('direct')
    expect(rows[0]?.waitedMs).toBeGreaterThanOrEqual(0)
    stop()
  })

  it('gives up after the repair cap rather than reopening in a loop', async () => {
    const { session, rows, stop } = harness()
    session.stranded = true
    await session.open()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(session.opens).toBe(3)
    expect(rows.filter((row) => row.phase === 'stranded')).toHaveLength(2)
    stop()
  })

  it('never repairs a session the app has removed', async () => {
    const { session, rows, stop } = harness()
    session.removed = true
    session.stranded = true
    await session.open()
    await vi.advanceTimersByTimeAsync(50)
    expect(session.opens).toBe(1)
    expect(rows).toEqual([])
    stop()
  })

  it('asks the app for its own resync when the first frame never arrives', async () => {
    const { session, rows, stop } = harness()
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_NO_FRAME_MS)
    expect(session.resyncs).toBe(1)
    const noFrame = rows.filter((row) => row.phase === 'no-frame')
    expect(noFrame).toHaveLength(1)
    expect(noFrame[0]).toMatchObject({ sessionId: 'session-1', resyncs: 1 })
    expect(noFrame[0]?.waitedMs).toBeGreaterThanOrEqual(SESSION_OPEN_GUARD_NO_FRAME_MS)
    // The retry is capped per session and page load, whatever the state after.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_NO_FRAME_MS * 10)
    expect(session.resyncs).toBe(2)
    expect(rows.filter((row) => row.phase === 'no-frame')).toHaveLength(2)
    session.pending = false
    session.release?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(session.openState).toBe('open')
    stop()
  })

  it('names the call that invalidated a loading session', async () => {
    const { session, rows, stop } = harness()
    session.stranded = true
    await session.open()
    await vi.advanceTimersByTimeAsync(0)
    const before = rows.length
    await session.dispose()
    const invalidated = rows.slice(before).filter((row) => row.phase === 'invalidated')
    expect(invalidated).toHaveLength(1)
    expect(invalidated[0]).toMatchObject({ by: 'dispose', sessionId: 'session-1' })
    expect(typeof invalidated[0]?.stack).toBe('string')
    stop()
  })

  it('reports the app\'s own reference rows when a loading session is invalidated', async () => {
    const { session, rows, stop } = harness('session', undefined, {
      retention: { referenceCount: 5, retainedBy: { mainView: 1, 'dsh-on-phone': 1, sidebarView: 3 } },
    })
    session.stranded = true
    await session.open()
    await vi.advanceTimersByTimeAsync(0)
    const before = rows.length
    await session.dispose()
    const invalidated = rows.slice(before).filter((row) => row.phase === 'invalidated')
    expect(invalidated[0]?.retention).toBe('5 mainView=1 dsh-on-phone=1 sidebarView=3')
    stop()
  })

  it('asks the app to re-open a session whose instance it has already retired', async () => {
    const { session, rows, live, asked, stop } = harness()
    // The main view's navigation was aborted: the retain was released, the scope
    // retired, and the manager dropped the instance the phone is still rendering.
    session.stranded = true
    live.delete(session.sessionId)
    await session.open()
    await vi.advanceTimersByTimeAsync(1)
    expect(asked).toEqual(['session-1'])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'session-open', phase: 'reselect', sessionId: 'session-1', repairs: 1 })
    expect(rows[0]?.mode).toBe('direct')
    // The orphan itself is left alone: opening it again only waits on a carrier
    // that is gone, which is the loop the device sat in for thirty seconds.
    expect(session.opens).toBe(1)
    stop()
  })

  it('repairs the retired instance in place when the app refuses to re-open it', async () => {
    const { session, rows, live, asked, stop } = harness('session', undefined, { reopenAccepted: false })
    session.stranded = true
    live.delete(session.sessionId)
    await session.open()
    await vi.advanceTimersByTimeAsync(1)
    // Asked once, refused, and not asked again; the in-place repair takes over
    // and spends its own budget.
    expect(asked).toEqual(['session-1'])
    expect(rows.filter((row) => row.phase === 'stranded')).toHaveLength(2)
    expect(session.opens).toBe(3)
    stop()
  })

  it('re-opens a retired session from the app only up to its own cap', async () => {
    const { session, rows, live, asked, stop } = harness('session', undefined, { maxReselects: 1 })
    session.stranded = true
    live.delete(session.sessionId)
    await session.open()
    await vi.advanceTimersByTimeAsync(1)
    // Budget spent, so the next strand falls back to the in-place repair.
    await session.open()
    await vi.advanceTimersByTimeAsync(1)
    expect(asked).toEqual(['session-1'])
    expect(rows.filter((row) => row.phase === 'reselect')).toHaveLength(1)
    expect(rows.filter((row) => row.phase === 'stranded')).toHaveLength(2)
    stop()
  })

  it('reports a resync that invalidates a loading session', async () => {
    const { session, rows, stop } = harness()
    session.stranded = true
    await session.open()
    await vi.advanceTimersByTimeAsync(0)
    const before = rows.length
    await session.resync()
    expect(rows.slice(before).filter((row) => row.phase === 'invalidated' && row.by === 'resync')).toHaveLength(1)
    stop()
  })

  it('wraps a prototype once, whatever the number of installs', async () => {
    const { session, rows, stop } = harness()
    // The same session, and so the same already-wrapped prototype.
    const second = harness('session', session)
    session.stranded = true
    await session.open()
    await vi.advanceTimersByTimeAsync(1)
    expect(second.rows).toEqual([])
    expect(rows.filter((row) => row.phase === 'stranded').length).toBeGreaterThan(0)
    stop()
    second.stop()
  })

  it('stays quiet, and returns a working stop, for a service of another shape', async () => {
    for (const shape of ['empty', 'array', 'none'] as const) {
      const { session, rows, stop } = harness(shape)
      session.stranded = true
      await session.open()
      await vi.advanceTimersByTimeAsync(50)
      expect(rows).toEqual([])
      expect(session.opens).toBe(1)
      expect(() => stop()).not.toThrow()
    }
  })

  it('holds its own reference while a session opens, and hands it back once the app owns it', async () => {
    const { session, rows, stop, holds, handbacks } = harness('session', undefined, { hold: true })
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(holds).toEqual(['session-1'])
    expect(rows.filter((row) => row.phase === 'hold')).toEqual([
      expect.objectContaining({ kind: 'session-open', phase: 'hold', sessionId: 'session-1', waitedMs: 0, mode: 'direct' }),
    ])
    // The first frame lands and the app takes the session back: no reason left
    // for the phone to keep it alive.
    session.release?.()
    await vi.advanceTimersByTimeAsync(250)
    expect(handbacks).toEqual(['app'])
    expect(rows.filter((row) => row.phase === 'handback')).toEqual([
      expect.objectContaining({ phase: 'handback', sessionId: 'session-1', reason: 'app' }),
    ])
    stop()
  })

  it('takes its reference synchronously, inside the `open()` call itself', () => {
    // The app's release happens in the same synchronous task as the open, so a
    // microtask is already too late: no timer, no await here on purpose.
    const { session, holds, stop } = harness('session', undefined, { hold: true })
    void session.open()
    expect(holds).toEqual(['session-1'])
    stop()
  })

  it('takes its reference as the open starts, before `loading` is even visible', async () => {
    // The device releases its own reference 12-16 ms into the open. A hold that
    // waited for `openState === 'loading'` to be observable missed that window,
    // so the guard takes it from the pass itself.
    const Deferred = class extends FakeSession {
      override async doOpen(): Promise<void> {
        await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
        this.openState = 'open'
      }
    }
    const session = new Deferred('session-1')
    const { holds, stop } = harness('session', session, { hold: true })
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(holds).toEqual(['session-1'])
    stop()
  })

  it('keeps the session alive when the app dropped it, then lets go of the hold', async () => {
    const { session, rows, stop, holds, handbacks } = harness('session', undefined, {
      hold: true,
      soleHolder: () => true,
    })
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(holds).toEqual(['session-1'])
    // The app's navigation was aborted and released the only reference it had:
    // the phone is now what keeps the session from being retired mid-open.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_HOLD_MAX_MS - 250)
    expect(handbacks).toEqual([])
    // The hold is not repeated for the same session and page load: it is given
    // back once, at the end of its grace period.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_HOLD_MAX_MS)
    expect(holds).toEqual(['session-1'])
    expect(handbacks).toEqual(['expired'])
    expect(rows.filter((row) => row.phase === 'handback')).toEqual([
      expect.objectContaining({ phase: 'handback', reason: 'expired' }),
    ])
    stop()
  })

  it('gives the hold back when the instance it was taken on is dropped', async () => {
    const { session, live, stop, holds, handbacks } = harness('session', undefined, {
      hold: true,
      soleHolder: () => true,
    })
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    live.delete(session.sessionId)
    await vi.advanceTimersByTimeAsync(250)
    expect(holds).toEqual(['session-1'])
    expect(handbacks).toEqual(['gone'])
    stop()
  })

  it('gives every hold back when the surface is stopped', async () => {
    const { session, stop, holds, handbacks } = harness('session', undefined, {
      hold: true,
      soleHolder: () => true,
    })
    session.pending = true
    void session.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(holds).toEqual(['session-1'])
    stop()
    expect(handbacks).toEqual(['stopped'])
    // Nothing is released twice.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_HOLD_MAX_MS * 2)
    expect(handbacks).toEqual(['stopped'])
  })

  it('survives a sessions service that throws when read', async () => {
    const rows: SessionOpenRecord[] = []
    const stop = installSessionOpenGuard({
      sessions: () => { throw new Error('service is half built') },
      endpoint: '/__dsh-mobile/telemetry',
      send: (_endpoint, payload) => { rows.push(JSON.parse(payload) as SessionOpenRecord) },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(rows).toEqual([])
    expect(() => stop()).not.toThrow()
  })
})
