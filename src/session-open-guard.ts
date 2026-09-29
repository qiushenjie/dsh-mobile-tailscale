/**
 * Repairing the app's own `openState = "loading"`, at the object layer.
 *
 * 「载入历史…」 is the host's view of `session.openState === "loading"`, and the
 * app sets that state in the session controller's `doOpen` *before* awaiting the
 * opening frame of the session's `session/follow` stream. That whole pass is
 * fenced by a generation number:
 *
 *     if (generation !== this.openGeneration || this.events !== events) return;
 *
 * so when something bumps `openGeneration` mid-open the pass returns without
 * publishing `openState = "open"` — and `open()`'s own `.finally` has already
 * cleared `openPromise`, so nothing is scheduled to try again. The view then sits
 * on the hint with no error and a perfectly healthy HTTP history page behind it,
 * which is exactly the ~2.5-3.0 s stall (and, before the DOM watch, the 13 s or
 * never) measured on the phone.
 *
 * `openGeneration` is bumped in only three places in the controller: `resync()`,
 * `dispose()` and `failEventStream()`. `dispose()` is the interesting one: it
 * does *not* touch `openState`, so disposing a session whose open is in flight
 * leaves it at `"loading"` forever. The device showed exactly that: a session
 * whose open started, and was disposed 12-24 ms later, because the navigation
 * that retained it was aborted and the app released the only reference.
 *
 * Two things answer for it, both where the state actually lives. The first is the
 * hold ({@link holdSessionOpen}): the phone takes a reference of its own as the
 * open starts, so the app's release cannot drop the count to zero mid-open, and
 * gives it back at the next sweep — no socket, no reload, no re-navigation. When
 * the app's own pass still settles with the state at `"loading"` and nobody
 * opening, the guard clears the stale `openPromise` and calls the app's own
 * `open()` again: a round trip, no socket touched. It also times out a first
 * frame that never arrives and asks the app for its own `resync()`, and it
 * instruments `dispose()`/`resync()` so a device row names what invalidated a
 * session mid-open.
 *
 * Everything here is feature-detected and wrapped: this is a guest in the app's
 * internals, so a shape that does not match reports zero and changes nothing.
 * @module dsh-mobile-tailscale/session-open-guard
 */

import { TELEMETRY_ENDPOINT } from './page-timing.js'
import { holdSessionOpen, readRetention, type SessionHoldHandle } from './session-hold.js'

/**
 * How long a `doOpen` pass gets to publish its opening frame before the app's
 * own `resync()` is asked for one. A healthy open publishes within a few hundred
 * milliseconds (the device measured 97-239 ms for a first paint), so this is the
 * earliest deadline that a slow-but-healthy open cannot trip.
 */
export const SESSION_OPEN_GUARD_NO_FRAME_MS = 800

/**
 * No-frame repairs allowed per sessionId per page load. One lost opening frame
 * is expected to be the whole story; the second is kept for a session switched
 * away from and back, and the cap stops a session that cannot open at all from
 * resyncing in a loop.
 */
export const SESSION_OPEN_GUARD_MAX_NO_FRAME_REPAIRS = 2

/**
 * Stranded repairs allowed per sessionId per page load. The strand is a single
 * lost wake-up, so the first repair is expected to be the end of it; a second is
 * kept for a session invalidated twice in a row, and the cap stops a session that
 * cannot open at all from being re-opened in a loop.
 */
export const SESSION_OPEN_GUARD_MAX_REPAIRS = 2

/**
 * App-level re-selections allowed per sessionId per page load.
 *
 * When the instance the phone renders is no longer the one the app hands out for
 * that id — the main view's retain was aborted, so the scope was retired and the
 * instance disposed — the only repair that can work is the app's own "open this
 * session", the call the sidebar makes on a tap. It is idempotent and cheap, but
 * it does move the main view, so it is budgeted separately from the in-place
 * repairs and a little more generously: the device showed the same session
 * stranded twice within three seconds.
 */
export const SESSION_OPEN_GUARD_MAX_RESELECTS = 6

/**
 * How long the phone's own reference may outlive the app's interest in a session.
 *
 * A hold taken while a session opens is given back as soon as the app holds it
 * again, which on the healthy path is the same tick. A session the app dropped
 * and never asked for again is the case where the phone is the only thing keeping
 * the view it already renders alive; it is held for this long, and then the
 * reference goes back so an abandoned session cannot be kept open for the life of
 * the page.
 */
export const SESSION_OPEN_GUARD_HOLD_MAX_MS = 60_000

/** Telemetry rows allowed per page load; a storm must not fill the log. */
export const SESSION_OPEN_GUARD_TELEMETRY_LIMIT = 12

/** How often the sessions service is looked for while it is still absent. */
export const SESSION_OPEN_GUARD_ARM_INTERVAL_MS = 250

/**
 * How many times the service is looked for. The shell paints before the
 * remembered session opens, so the prototype is normally found on the first
 * attempt; the bound (240 x 250 ms, one minute) only covers a host that restores
 * no session at all, and it stops early the moment a prototype is wrapped —
 * after that the wrapper covers every instance the app creates later.
 */
export const SESSION_OPEN_GUARD_ARM_ATTEMPTS = 240

/** Stack lines kept from an invalidating call site: the controller frame and a little context. */
export const SESSION_OPEN_GUARD_STACK_LINES = 6

/**
 * Hidden own property marking a prototype this module already wrapped. Like
 * `open()`'s own `.finally`, it is what keeps a re-install from stacking wrappers
 * on a class the host may evaluate more than once.
 */
const PROTOTYPE_MARK = '__dshMobileSessionOpenGuard__'

/** Session id reported when the app exposes none. */
const UNKNOWN_SESSION_ID = 'unknown'

/** Which half of the strand a row describes. */
export type SessionOpenPhase = 'hold' | 'handback' | 'stranded' | 'no-frame' | 'invalidated' | 'reselect'

/** The method that bumped the generation while a session was loading. */
export type SessionInvalidator = 'dispose' | 'resync'

/** One report about a session the app left loading. */
export interface SessionOpenRecord {
  kind: 'session-open'
  at: string
  phase: SessionOpenPhase
  sessionId: string
  /** How long the pass (or the loading state) had been going when this ran. */
  waitedMs: number
  /** The session's transport mode, when the app exposes one. */
  mode?: string
  /** The invalidating method, on `invalidated`. */
  by?: SessionInvalidator
  /** Trimmed stack of the invalidating call, on `invalidated`. */
  stack?: string
  /** Repair number within the cap, on `stranded`. */
  repairs?: number
  /** Resyncs asked for, on `no-frame`. */
  resyncs?: number
  /** Why a held reference was given back, on `handback`. */
  reason?: string
  /** The app's own retrieval row when the row was written, as `count source=count`. */
  retention?: string
}

/** One session instance, as far as this guard reaches into it. */
export interface GuardableSession {
  sessionId?: unknown
  openState?: unknown
  openPromise?: unknown
  removed?: unknown
  address?: { mode?: unknown } | undefined
  open?(): unknown
  doOpen?(...args: unknown[]): unknown
  dispose?(): unknown
  resync?(): unknown
}

/** One held reference: the instance it was taken on, and when. */
interface HoldEntry {
  handle: SessionHoldHandle
  session: GuardableSession
  startedAt: number
}

/** The app's `sessions` service, as far as this guard reaches into it. */
export interface SessionOpenGuardService {
  manager?: {
    /**
     * The app's id-to-instance map. `get` is what tells a live instance from one
     * the app has already retired: the retired instance is no longer the value
     * under its own id, and nothing will ever open it again.
     */
    sessions?: {
      get?: (sessionId: string) => unknown
      values?: () => Iterable<GuardableSession | undefined>
    }
  }
}

/** Injectable environment, so the repair can be driven turn by turn in tests. */
export interface SessionOpenGuardOptions {
  /** The app's `sessions` service, resolved lazily: it may register after mount. */
  sessions: () => unknown
  /**
   * The app's own "open this session in the main view", normally
   * {@link reselectSession} over `ctx.get('uiWorkspace')`. Called when the
   * instance the phone renders is no longer the one the app hands out for that
   * id; returns whether the app could be asked.
   */
  reopenSession?: (sessionId: string) => boolean
  /**
   * The phone's own reference to a session that is opening, normally
   * {@link holdSessionOpen} over `ctx.get('sessions')`. This is what keeps the
   * app from retiring — and disposing — a session whose open is in flight.
   * Absent, or returning undefined, leaves the app exactly as it was.
   */
  holdSession?: (sessionId: string) => SessionHoldHandle | undefined
  endpoint?: string
  send?: (endpoint: string, payload: string) => void
  now?: () => number
  setTimeout?: (callback: () => void, ms: number) => number
  clearTimeout?: (handle: number) => void
  setInterval?: (callback: () => void, ms: number) => number
  clearInterval?: (handle: number) => void
  noFrameMs?: number
  maxRepairs?: number
  maxNoFrameRepairs?: number
  maxReselects?: number
  holdMaxMs?: number
  telemetryLimit?: number
  armIntervalMs?: number
  armAttempts?: number
}

/** A method as it arrives from the app's class. */
type GuardMethod = (this: GuardableSession, ...args: unknown[]) => unknown

/**
 * Wrap the session class' `doOpen`/`dispose`/`resync`, once per prototype.
 *
 * The sessions service is resolved on every arm attempt rather than at mount:
 * the plugin's client half is evaluated before the app's own services exist, and
 * the class prototype found on any later attempt covers every instance — present
 * and future — because the app dispatches through the prototype.
 * @param options - The service getter and injectable clock, timers, and telemetry.
 * @returns A function that stops the arming poll; installed wrappers stay.
 */
export function installSessionOpenGuard(options: SessionOpenGuardOptions): () => void {
  const now = options.now ?? ((): number => Date.now())
  const schedule = options.setTimeout
    ?? ((callback: () => void, ms: number): number => globalThis.setTimeout(callback, ms) as unknown as number)
  const unschedule = options.clearTimeout
    ?? ((handle: number): void => {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>)
    })
  const scheduleInterval = options.setInterval
    ?? ((callback: () => void, ms: number): number => globalThis.setInterval(callback, ms) as unknown as number)
  const unscheduleInterval = options.clearInterval
    ?? ((handle: number): void => {
      globalThis.clearInterval(handle as unknown as ReturnType<typeof globalThis.setInterval>)
    })
  const send = options.send ?? defaultSend
  const endpoint = options.endpoint ?? TELEMETRY_ENDPOINT
  const noFrameMs = options.noFrameMs ?? SESSION_OPEN_GUARD_NO_FRAME_MS
  const maxRepairs = options.maxRepairs ?? SESSION_OPEN_GUARD_MAX_REPAIRS
  const maxNoFrameRepairs = options.maxNoFrameRepairs ?? SESSION_OPEN_GUARD_MAX_NO_FRAME_REPAIRS
  const maxReselects = options.maxReselects ?? SESSION_OPEN_GUARD_MAX_RESELECTS
  const holdMaxMs = options.holdMaxMs ?? SESSION_OPEN_GUARD_HOLD_MAX_MS
  const telemetryLimit = options.telemetryLimit ?? SESSION_OPEN_GUARD_TELEMETRY_LIMIT
  const armIntervalMs = options.armIntervalMs ?? SESSION_OPEN_GUARD_ARM_INTERVAL_MS
  const armAttempts = options.armAttempts ?? SESSION_OPEN_GUARD_ARM_ATTEMPTS

  /** Sessions this guard has actually seen, for the invalidation diagnosis. */
  const known = new WeakSet<object>()
  /** Stranded repairs spent, per sessionId, for this page load. */
  const repairs = new Map<string, number>()
  /** No-frame repairs spent, per sessionId, for this page load. */
  const noFrameRepairs = new Map<string, number>()
  /** The phone's own reference to each session whose open is in flight. */
  const holds = new Map<string, HoldEntry>()
  /** Sessions a `hold` row has already been written for, per page load. */
  const holdReported = new Set<string>()
  /** App-level re-selections the app accepted, per sessionId, for this page load. */
  const reselects = new Map<string, number>()
  /** Sessions the app would not re-open; one refusal ends the app-level path. */
  const reselectRefused = new Set<string>()
  /** When each session last entered a pass, for `waitedMs`. */
  const loadingSince = new Map<string, number>()
  let sent = 0

  const report = (
    phase: SessionOpenPhase,
    sessionId: string,
    waitedMs: number,
    extra: {
      mode?: string | undefined
      by?: SessionInvalidator | undefined
      stack?: string | undefined
      repairs?: number | undefined
      resyncs?: number | undefined
      reason?: string | undefined
      retention?: string | undefined
    } = {},
  ): void => {
    if (sent >= telemetryLimit) return
    try {
      const record: SessionOpenRecord = {
        kind: 'session-open',
        at: new Date(now()).toISOString(),
        phase,
        sessionId,
        waitedMs: Math.max(0, Math.round(waitedMs)),
        ...(extra.mode === undefined ? {} : { mode: extra.mode }),
        ...(extra.by === undefined ? {} : { by: extra.by }),
        ...(extra.stack === undefined ? {} : { stack: extra.stack }),
        ...(extra.repairs === undefined ? {} : { repairs: extra.repairs }),
        ...(extra.resyncs === undefined ? {} : { resyncs: extra.resyncs }),
        ...(extra.reason === undefined ? {} : { reason: extra.reason }),
        ...(extra.retention === undefined ? {} : { retention: extra.retention }),
      }
      sent += 1
      send(endpoint, JSON.stringify(record))
    } catch {
      // Telemetry must never surface as an error, and never disturb a repair.
    }
  }

  /**
   * The app's reference rows for one session, as a one-line string, so a single
   * telemetry line says whether the phone's own hold was in the count when the
   * row was written. `undefined` when the app publishes nothing to read.
   */
  const retentionField = (sessionId: string): { retention?: string } => {
    try {
      const rows = readRetention(options.sessions(), sessionId)
      if (rows === undefined) return {}
      const sources = Object.entries(rows.retainedBy ?? {})
        .map(([source, count]) => `${source}=${count}`)
        .join(' ')
      return { retention: `${rows.referenceCount ?? 0}${sources === '' ? '' : ` ${sources}`}` }
    } catch {
      return {}
    }
  }

  const idOf = (session: GuardableSession): string => {
    try {
      const id = session.sessionId
      if (typeof id === 'string' && id.length > 0) return id
      if (typeof id === 'number') return String(id)
    } catch {
      // A getter that throws is not a session this guard can name.
    }
    return UNKNOWN_SESSION_ID
  }

  const modeOf = (session: GuardableSession): string | undefined => {
    try {
      const mode = session.address?.mode
      return typeof mode === 'string' ? mode : undefined
    } catch {
      return undefined
    }
  }

  const isLoading = (session: GuardableSession): boolean => {
    try {
      return session.openState === 'loading'
    } catch {
      return false
    }
  }

  const isRemoved = (session: GuardableSession): boolean => {
    try {
      return session.removed === true
    } catch {
      return false
    }
  }

  /**
   * Whether `openPromise` is this settled pass' own, rather than a newer one.
   *
   * `open()`'s `.finally` nulls the field as the pass settles, so at repair time
   * a live open shows up as a promise this pass never produced. Identity is a
   * second signal for a host (or a fixture) that stores the `doOpen` return value
   * verbatim: a promise that has already settled is not an open in flight.
   * @param session - The session the pass ran on.
   * @param pass - The value this pass' own `doOpen` returned.
   * @returns True when nothing is scheduled to publish the opening frame.
   */
  const isStaleOpenPromise = (session: GuardableSession, pass: unknown): boolean => {
    try {
      const promise = session.openPromise
      return promise === null || promise === undefined || promise === pass
    } catch {
      return true
    }
  }

  /**
   * Whether the app has already retired this instance.
   *
   * The main view holds a session by retaining it; when a fast switch aborts the
   * navigation, the retain is released, the scope retires, and the manager drops
   * the instance. That instance is what the phone keeps rendering, and it can
   * never open again — its transport belongs to a connection generation that is
   * gone. The managers map is the only place that says so.
   * @param session - The instance the stranded pass ran on.
   * @param sessionId - The id it was published under.
   * @returns True when the app no longer hands this instance out for that id.
   */
  const isRetired = (session: GuardableSession, sessionId: string): boolean => {
    if (sessionId === UNKNOWN_SESSION_ID) return false
    let service: unknown
    try {
      service = options.sessions()
    } catch {
      return false
    }
    const live = (service as SessionOpenGuardService | undefined)?.manager?.sessions
    if (live === undefined || typeof live.get !== 'function') return false
    try {
      return live.get(sessionId) !== session
    } catch {
      return false
    }
  }

  /** The live sessions the app is holding, when the service has the shape we know. */
  const liveSessions = (): GuardableSession[] => {
    let service: unknown
    try {
      service = options.sessions()
    } catch {
      return []
    }
    const live = (service as SessionOpenGuardService | undefined)?.manager?.sessions
    if (live === undefined || typeof live.values !== 'function') return []
    const found: GuardableSession[] = []
    try {
      for (const session of live.values()) {
        if (session === null || typeof session !== 'object') continue
        found.push(session)
      }
    } catch {
      // A map that throws mid-iteration still yields the sessions it gave.
    }
    return found
  }

  /**
   * Take the phone's own reference to a session that is opening.
   *
   * This is the repair that makes a session switch instant: the app's navigation
   * releases its reference 12-16 ms into the open (measured), and an unheld
   * session is then retired and disposed *while loading*, which is the state the
   * view never leaves. The hold is taken as the pass starts, without waiting for
   * `loading` to be observable, so it is in place before that release. One row is
   * written per session per page load; the sweeps that follow report the
   * hand-back.
   * @param session - The instance entering `loading`.
   * @param sessionId - Its published id.
   */
  const takeHold = (session: GuardableSession, sessionId: string): void => {
    if (sessionId === UNKNOWN_SESSION_ID) return
    const existing = holds.get(sessionId)
    if (existing !== undefined) {
      if (existing.session === session) return
      // The app re-materialised the id; the old instance is not what is opening.
      releaseHold(sessionId, 'replaced')
    }
    let handle: SessionHoldHandle | undefined
    try {
      handle = options.holdSession?.(sessionId)
    } catch {
      handle = undefined
    }
    if (handle === undefined) return
    holds.set(sessionId, { handle, session, startedAt: now() })
    if (holdReported.has(sessionId)) return
    holdReported.add(sessionId)
    const mode = modeOf(session)
    report('hold', sessionId, 0, { ...(mode === undefined ? {} : { mode }), ...retentionField(sessionId) })
  }

  /** Give one held reference back, and say why. */
  const releaseHold = (sessionId: string, reason: string): void => {
    const entry = holds.get(sessionId)
    if (entry === undefined) return
    holds.delete(sessionId)
    try {
      entry.handle.release(reason)
    } catch {
      // The reference is gone either way; the session keeps its own life.
    }
    report('handback', sessionId, now() - entry.startedAt, { reason })
  }

  /**
   * Give each held reference back once the app owns the session again.
   *
   * The healthy path hands the reference back on the sweep after the app's own
   * `retain`, so the phone is never the reason a session stays alive. A session
   * the app dropped — the aborted-navigation case — keeps the phone's reference
   * until {@link SESSION_OPEN_GUARD_HOLD_MAX_MS} has passed, because the view that
   * is already rendering it must finish its open.
   */
  const sweepHolds = (): void => {
    if (holds.size === 0) return
    const live = new Map<string, GuardableSession>()
    for (const session of liveSessions()) live.set(idOf(session), session)
    for (const sessionId of [...holds.keys()]) {
      const entry = holds.get(sessionId)
      if (entry === undefined) continue
      const session = live.get(sessionId)
      if (session === undefined) {
        releaseHold(sessionId, 'gone')
        continue
      }
      if (session !== entry.session) {
        releaseHold(sessionId, 'replaced')
        continue
      }
      if (!entry.handle.soleHolder()) {
        releaseHold(sessionId, 'app')
        continue
      }
      if (now() - entry.startedAt >= holdMaxMs) releaseHold(sessionId, 'expired')
    }
  }

  /** The first known session the app currently reports as loading. */
  const firstKnownLoading = (): GuardableSession | undefined => {
    for (const session of liveSessions()) {
      if (!known.has(session)) continue
      if (isLoading(session)) return session
    }
    return undefined
  }

  /** The calling stack, trimmed to the controller frame and a little context. */
  const trimmedStack = (): string | undefined => {
    try {
      const stack = new Error().stack
      if (typeof stack !== 'string') return undefined
      return stack.split('\n').slice(0, SESSION_OPEN_GUARD_STACK_LINES).join('\n')
    } catch {
      return undefined
    }
  }

  /**
   * Record an invalidation that will strand a loading session.
   *
   * `dispose()` bumps the generation without touching `openState`; `resync()`
   * bumps it and re-opens. Both can run while an open is in flight, and until the
   * device shows which one does, the stack of the call is the whole answer.
   */
  const diagnose = (by: SessionInvalidator, session: GuardableSession): void => {
    const victim = known.has(session) && isLoading(session) ? session : firstKnownLoading()
    if (victim === undefined) return
    const sessionId = idOf(victim)
    const startedAt = loadingSince.get(sessionId)
    const mode = modeOf(victim)
    const stack = trimmedStack()
    report('invalidated', sessionId, startedAt === undefined ? 0 : now() - startedAt, {
      ...(mode === undefined ? {} : { mode }),
      by,
      ...(stack === undefined ? {} : { stack }),
      ...retentionField(sessionId),
    })
  }

  /**
   * The stale-return strand: the pass settled, the state is still `"loading"`,
   * and no open is scheduled. Repairing means clearing the promise the settled
   * pass already cleared (so `open()` cannot return it) and asking the app to
   * open again on the carrier that is up.
   *
   * One instance cannot be repaired that way at all: the retired one. Its
   * transport belongs to a connection generation that is gone, so every pass on
   * it — including one this guard starts — hangs until something kills it, which
   * is exactly the loop the device showed. For that case the repair is the app's
   * own navigation instead, which retains a current instance for the id.
   */
  const repairStranded = (
    session: GuardableSession,
    sessionId: string,
    pass: unknown,
    startedAt: number,
    resyncedThisPass: boolean,
  ): void => {
    if (resyncedThisPass) return
    if (isRemoved(session)) return
    if (!isLoading(session)) return
    const retired = isRetired(session, sessionId)
    const canReopen = session.open !== undefined
    // A live instance is repaired only when its own pass settled without opening
    // it; a retired one is repaired whenever it is still loading, because the pass
    // it may be waiting on belongs to a dead generation. Either way an open has to
    // be available, or there is nothing to hand the repair to.
    const stranded = isStaleOpenPromise(session, pass) && canReopen
    const canReselect = retired && options.reopenSession !== undefined
    if (!canReselect && !stranded) return
    const mode = modeOf(session)
    if (canReselect) {
      const asked = reselects.get(sessionId) ?? 0
      if (asked < maxReselects && !reselectRefused.has(sessionId)) {
        let reopened = false
        try {
          reopened = options.reopenSession?.(sessionId) === true
        } catch {
          reopened = false
        }
        if (reopened) {
          reselects.set(sessionId, asked + 1)
          loadingSince.set(sessionId, now())
          report('reselect', sessionId, now() - startedAt, {
            ...(mode === undefined ? {} : { mode }),
            repairs: asked + 1,
          })
          return
        }
        // Asked and refused: the app's navigation is not going to move for this
        // session, so the in-place repair is what is left, and asking again would
        // only add a call per strand.
        reselectRefused.add(sessionId)
      }
    }
    if (!stranded) return
    const reopen = session.open
    if (reopen === undefined) return
    const spent = repairs.get(sessionId) ?? 0
    if (spent >= maxRepairs) return
    repairs.set(sessionId, spent + 1)
    loadingSince.set(sessionId, now())
    report('stranded', sessionId, now() - startedAt, {
      ...(mode === undefined ? {} : { mode }),
      repairs: spent + 1,
    })
    session.openPromise = null
    reopen.call(session)
  }

  /**
   * Wrap one prototype. Re-installs are no-ops: the prototype carries a hidden
   * mark, and the wrapper is shared by every instance the app builds afterwards.
   * @param prototype - The session class' prototype.
   * @returns One when this call wrapped it, zero when it was already wrapped.
   */
  const wrapPrototype = (prototype: object): number => {
    if ((prototype as Record<string, unknown>)[PROTOTYPE_MARK] === true) return 0
    const methods = prototype as { open?: unknown; doOpen?: unknown; dispose?: unknown; resync?: unknown }
    const originalDoOpen = methods.doOpen
    if (typeof originalDoOpen !== 'function') return 0
    const openPass = originalDoOpen as GuardMethod
    const originalOpen = typeof methods.open === 'function' ? (methods.open as GuardMethod) : undefined
    const originalDispose = typeof methods.dispose === 'function' ? (methods.dispose as GuardMethod) : undefined
    const originalResync = typeof methods.resync === 'function' ? (methods.resync as GuardMethod) : undefined

    /** Guards the re-entrant `open()` that `retain()` itself performs. */
    let takingHold = false

    /**
     * The public `open()`: the point at which the reference has to exist.
     *
     * `retain()` starts the open, and the navigation it was retained under can
     * release its reference in the *same synchronous task* — measured 13-18 ms
     * after the pass began, with the phone's hold 15 ms later, because a
     * microtask cannot run inside that task. Taking the hold here, before the
     * pass runs at all, puts it ahead of the release instead of behind it.
     * `retain()` itself calls `open()`, which re-enters this wrapper; the flag
     * makes that re-entry take the original path.
     */
    const wrappedOpen = function (this: GuardableSession, ...args: unknown[]): unknown {
      if (originalOpen === undefined) return undefined
      try {
        const session = this
        const sessionId = idOf(session)
        const held = holds.get(sessionId)
        if (
          !takingHold &&
          sessionId !== UNKNOWN_SESSION_ID &&
          held?.session !== session &&
          session.openState !== 'open' &&
          session.openPromise === null
        ) {
          takingHold = true
          try {
            takeHold(session, sessionId)
          } catch {
            // A hold that cannot be taken leaves the app exactly as it was.
          } finally {
            takingHold = false
          }
        }
      } catch {
        // Observation only: the caller still gets the original result.
      }
      return originalOpen.apply(this, args)
    }

    /**
     * The original pass, observed. The returned value is the original's own, so
     * a caller (and `open()`'s `.finally`) sees exactly what it would have seen.
     */
    const wrappedDoOpen = function (this: GuardableSession, ...args: unknown[]): unknown {
      const result = openPass.apply(this, args)
      try {
        const session = this
        known.add(session)
        const sessionId = idOf(session)
        const startedAt = now()
        loadingSince.set(sessionId, startedAt)
        // Take the phone's reference as the open starts — but a microtask later,
        // because retaining calls `open()` again and `open()` has not yet wired
        // its own `openPromise` during this synchronous frame; taking it here
        // would re-enter `doOpen` and start a second pass.
        void Promise.resolve().then(() => {
          try {
            takeHold(session, sessionId)
          } catch {
            // A hold that cannot be taken leaves the app exactly as it was.
          }
        })
        let settled = false
        let resyncedThisPass = false

        const settle = (): void => {
          settled = true
          try {
            unschedule(timer)
          } catch {
            // A timer that cannot be cleared only costs one no-op callback.
          }
          // After `open()`'s own `.finally`: that is where `openPromise` is
          // cleared, so the strand check has to read the finished state.
          schedule(() => {
            try {
              repairStranded(session, sessionId, result, startedAt, resyncedThisPass)
            } catch {
              // A repair that throws is still better than a broken app.
            }
          }, 0)
        }

        // The opening frame never arrives: ask the app for its own resync, which
        // disposes the stuck stream and opens again on the carrier already up.
        const timer = schedule(() => {
          try {
            if (settled) return
            if (isRemoved(session)) return
            if (!isLoading(session)) return
            if (resyncedThisPass) return
            const spent = noFrameRepairs.get(sessionId) ?? 0
            if (spent >= maxNoFrameRepairs) return
            noFrameRepairs.set(sessionId, spent + 1)
            resyncedThisPass = true
            const mode = modeOf(session)
            report('no-frame', sessionId, now() - startedAt, {
              ...(mode === undefined ? {} : { mode }),
              resyncs: spent + 1,
            })
            void session.resync?.()
          } catch {
            // The resync is best-effort; the DOM watch remains the outer net.
          }
        }, noFrameMs)

        void Promise.resolve(result).then(settle, settle)
      } catch {
        // Observation only: the caller still gets the original result.
      }
      return result
    }

    const wrappedDispose = function (this: GuardableSession, ...args: unknown[]): unknown {
      try {
        diagnose('dispose', this)
      } catch {
        // Diagnosis is best-effort; the disposal keeps its own behaviour.
      }
      return originalDispose === undefined ? undefined : originalDispose.apply(this, args)
    }

    const wrappedResync = function (this: GuardableSession, ...args: unknown[]): unknown {
      try {
        diagnose('resync', this)
      } catch {
        // Diagnosis is best-effort; the resync keeps its own behaviour.
      }
      return originalResync === undefined ? undefined : originalResync.apply(this, args)
    }

    try {
      Object.defineProperty(prototype, 'doOpen', {
        value: wrappedDoOpen,
        writable: true,
        configurable: true,
        enumerable: false,
      })
    } catch {
      return 0
    }
    if (originalOpen !== undefined) {
      try {
        Object.defineProperty(prototype, 'open', {
          value: wrappedOpen,
          writable: true,
          configurable: true,
          enumerable: false,
        })
      } catch {
        // The microtask hold in `doOpen` remains as the later net.
      }
    }
    if (originalDispose !== undefined) {
      try {
        Object.defineProperty(prototype, 'dispose', {
          value: wrappedDispose,
          writable: true,
          configurable: true,
          enumerable: false,
        })
      } catch {
        // `doOpen` is the repair; the diagnosis is a bonus.
      }
    }
    if (originalResync !== undefined) {
      try {
        Object.defineProperty(prototype, 'resync', {
          value: wrappedResync,
          writable: true,
          configurable: true,
          enumerable: false,
        })
      } catch {
        // Same: losing the diagnosis does not lose the repair.
      }
    }
    try {
      Object.defineProperty(prototype, PROTOTYPE_MARK, { value: true })
    } catch {
      // The mark only guards against a double install of an already-wrapped class.
    }
    return 1
  }

  /** Look for the sessions service, and wrap the class prototype once it exists. */
  const tryArm = (): number => {
    let wrapped = 0
    for (const session of liveSessions()) {
      known.add(session)
      let prototype: object | null = null
      try {
        prototype = Object.getPrototypeOf(session) as object | null
      } catch {
        prototype = null
      }
      if (prototype === null || typeof prototype !== 'object') continue
      try {
        wrapped += wrapPrototype(prototype)
      } catch {
        // A prototype that refuses the hook is left exactly as it was.
      }
    }
    return wrapped
  }

  let interval: number | undefined
  const stopArming = (): void => {
    if (interval === undefined) return
    try {
      unscheduleInterval(interval)
    } catch {
      // Nothing to stop.
    }
    interval = undefined
  }

  let attempts = 0
  const armTick = (): void => {
    attempts += 1
    let wrapped = 0
    try {
      wrapped = tryArm()
    } catch {
      wrapped = 0
    }
    if (wrapped > 0 || attempts >= armAttempts) stopArming()
  }

  // Immediate first attempt, then the bounded poll: the shell paints before the
  // remembered session opens, so this normally wraps on the first tick.
  interval = scheduleInterval(armTick, armIntervalMs)
  armTick()

  // Holds outlive the arming poll, so their sweep gets its own interval: it runs
  // for as long as this surface is mounted, which is exactly as long as a held
  // reference may exist.
  let sweep: number | undefined
  const stopSweeping = (): void => {
    if (sweep !== undefined) {
      try {
        unscheduleInterval(sweep)
      } catch {
        // Nothing to stop.
      }
      sweep = undefined
    }
    // Never leave a reference behind: a page that is going away must not keep a
    // session open.
    for (const sessionId of [...holds.keys()]) {
      try {
        releaseHold(sessionId, 'stopped')
      } catch {
        // The page is going away; a failed release is the app's to reap.
      }
    }
  }
  sweep = scheduleInterval(() => {
    try {
      sweepHolds()
    } catch {
      // A sweep that throws must not take the app down with it.
    }
  }, armIntervalMs)

  return () => { stopArming(); stopSweeping() }
}

/**
 * Post one row. `keepalive` lets the last row of a page survive a reload, and a
 * failure is ignored: telemetry must never surface as an error.
 * @param endpoint - Telemetry URL.
 * @param body - Serialised row.
 */
function defaultSend(endpoint: string, body: string): void {
  if (typeof fetch !== 'function') return
  void fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined)
}
