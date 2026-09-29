import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  installSessionOpenGuard,
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
}

/**
 * A fresh subclass per harness: the guard marks and wraps one prototype per
 * page load, so tests must not share it (a mark from an earlier test would
 * leave that test's wrappers — and its telemetry — in charge).
 */
function newSession(): FakeSession {
  const Fresh = class extends FakeSession {}
  return new Fresh('session-1')
}

function harness(shape: 'session' | 'empty' | 'array' | 'none' = 'session', held?: FakeSession): Harness {
  const session = held ?? newSession()
  const rows: SessionOpenRecord[] = []
  const service = (): unknown => {
    if (shape === 'session') return { manager: { sessions: new Map([[session.sessionId, session]]) } }
    if (shape === 'empty') return { manager: { sessions: new Map() } }
    if (shape === 'array') return { manager: { sessions: [] } }
    return undefined
  }
  const stop = installSessionOpenGuard({
    sessions: service,
    endpoint: '/__dsh-mobile/telemetry',
    send: (_endpoint, payload) => { rows.push(JSON.parse(payload) as SessionOpenRecord) },
  })
  return { session, service, rows, stop }
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
    // The retry is one per session and page load, whatever the state afterwards.
    await vi.advanceTimersByTimeAsync(SESSION_OPEN_GUARD_NO_FRAME_MS * 10)
    expect(session.resyncs).toBe(1)
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
