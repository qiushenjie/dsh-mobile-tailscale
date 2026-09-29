/**
 * Asking the app to re-open the conversations it is showing as loading.
 *
 * 「载入历史…」 is the host's `openState = "loading"` hint, and the app sets that
 * state in its session controller's `doOpen` *before* awaiting the opening frame
 * of the session's `session/follow` stream. That pass is fenced by a generation:
 * a stream replacement bumps it and the pass drops its result instead of
 * publishing `openState = "open"`, so the view can sit on the hint with nothing
 * scheduled to retry. Measured on the device with the HTTP side perfectly
 * healthy (13 page calls, none in flight, the last answering in 51 ms) and no
 * outstanding `session/follow` open on the carrier, the only recovery was to
 * close the app's mux socket — which costs a full re-subscription (workspace
 * follow, jobs, terminal) and took 13 s.
 *
 * The session controller carries the retry for exactly this case: `resync()`
 * bumps the generation, disposes the stuck stream and opens again, on the
 * *existing* carrier. The app calls it when the viewed session's address
 * changes; the stuck-view watch calls it when the view is stuck.
 *
 * Everything here is feature-detected. The client half is a guest in the app's
 * internals, so a shape that does not match reports zero and leaves the socket
 * rebuild to do the work.
 */

/** One session instance, as far as the resync reaches into it. */
export interface ResyncableSession {
  getSnapshot?(): { openState?: unknown } | undefined
  resync?(): unknown
}

/** The app's `sessions` service, as far as the resync reaches into it. */
export interface ResyncSessionsService {
  manager?: {
    sessions?: { values?: () => Iterable<ResyncableSession | undefined> }
  }
}

/**
 * Re-open every session the app currently reports as loading.
 * @param sessions - The app's `sessions` service, when this build has one.
 * @returns How many sessions were asked to re-open.
 */
export function resyncLoadingSessions(sessions: unknown): number {
  const live = (sessions as ResyncSessionsService | undefined)?.manager?.sessions
  if (live === undefined || typeof live.values !== 'function') return 0
  let resynced = 0
  for (const session of live.values()) {
    if (session === undefined || typeof session.resync !== 'function') continue
    let openState: unknown
    try {
      openState = session.getSnapshot?.()?.openState
    } catch {
      // A half-built session is not one this watch can rescue.
      continue
    }
    if (openState !== 'loading') continue
    try {
      void session.resync()
      resynced += 1
    } catch {
      // The socket rebuild is the fallback, so a refusal here is not fatal.
    }
  }
  return resynced
}
