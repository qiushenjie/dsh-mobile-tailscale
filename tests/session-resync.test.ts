import { describe, expect, it } from 'vitest'

import { resyncLoadingSessions, type ResyncableSession } from '../src/session-resync.js'

/** A session instance that records the calls it receives. */
function session(openState: unknown, options: { resync?: boolean } = {}): ResyncableSession & { resyncs: number } {
  const record = {
    resyncs: 0,
    getSnapshot: () => ({ openState }),
    resync(): void {
      record.resyncs += 1
    },
  }
  if (options.resync === false) delete (record as { resync?: unknown }).resync
  return record
}

/** The app's service, holding the given sessions. */
function service(sessions: Array<ResyncableSession | undefined>): unknown {
  return { manager: { sessions: new Map(sessions.map((entry, index) => [String(index), entry])) } }
}

describe('resyncLoadingSessions', () => {
  it('re-opens every session the app reports as loading', () => {
    const loading = session('loading')
    const open = session('open')
    const cold = session('cold')
    expect(resyncLoadingSessions(service([loading, open, cold]))).toBe(1)
    expect(loading.resyncs).toBe(1)
    expect(open.resyncs).toBe(0)
    expect(cold.resyncs).toBe(0)
  })

  it('re-opens each stuck session once, not once per poll', () => {
    const first = session('loading')
    const second = session('loading')
    expect(resyncLoadingSessions(service([first, second]))).toBe(2)
    expect(first.resyncs).toBe(1)
    expect(second.resyncs).toBe(1)
  })

  it('reports zero for a session without a readable state or without the retry', () => {
    expect(resyncLoadingSessions(service([{ resync: () => undefined }]))).toBe(0)
    expect(resyncLoadingSessions(service([session('loading', { resync: false })]))).toBe(0)
  })

  it('reports zero, rather than throwing, for a service of another shape', () => {
    expect(resyncLoadingSessions(undefined)).toBe(0)
    expect(resyncLoadingSessions({})).toBe(0)
    expect(resyncLoadingSessions({ manager: {} })).toBe(0)
    expect(resyncLoadingSessions({ manager: { sessions: [] } })).toBe(0)
  })

  it('survives a session whose snapshot or retry throws', () => {
    const broken: ResyncableSession = {
      getSnapshot: () => {
        throw new Error('session is half built')
      },
      resync: () => undefined,
    }
    const throwing: ResyncableSession = {
      getSnapshot: () => ({ openState: 'loading' }),
      resync: () => {
        throw new Error('refused')
      },
    }
    const good = session('loading')
    expect(resyncLoadingSessions(service([broken, throwing, good]))).toBe(1)
    expect(good.resyncs).toBe(1)
  })
})
