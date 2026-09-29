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
 * leaves it at `"loading"` forever. The DOM watch in `stuck-view.ts` is the outer
 * net — it can only see the hint and can only answer by rebuilding carriers
 * (7-11 s on the device). This module answers where the state actually lives: it
 * wraps the session class' `doOpen` (once per prototype) and, after the original
 * settles with the state still `"loading"` and nobody opening, clears the stale
 * `openPromise` and calls the app's own `open()` again — a round trip, no socket
 * touched. It also times out a first frame that never arrives and asks the app
 * for its own `resync()`, and it instruments `dispose()`/`resync()` so the next
 * device row finally names which call invalidated a session mid-open.
 *
 * Everything here is feature-detected and wrapped: this is a guest in the app's
 * internals, so a shape that does not match reports zero and changes nothing.
 * @module dsh-mobile-tailscale/session-open-guard
 */

import { TELEMETRY_ENDPOINT } from './page-timing.js'

/**
 * How long a `doOpen` pass gets to publish its opening frame before the app's
 * own `resync()` is asked for one. A healthy open publishes within a few hundred
 * milliseconds; the device measured 1-6 s for a slow one, and the DOM watch only
 * acts at 2 s, so this is the early, cheap retry in front of it.
 */
export const SESSION_OPEN_GUARD_NO_FRAME_MS = 1_500

/**
 * Stranded repairs allowed per sessionId per page load. The strand is a single
 * lost wake-up, so the first repair is expected to be the end of it; a second is
 * kept for a session invalidated twice in a row, and the cap stops a session that
 * cannot open at all from being re-opened in a loop.
 */
export const SESSION_OPEN_GUARD_MAX_REPAIRS = 2

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
export type SessionOpenPhase = 'stranded' | 'no-frame' | 'invalidated'

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

/** The app's `sessions` service, as far as this guard reaches into it. */
export interface SessionOpenGuardService {
  manager?: {
    sessions?: { values?: () => Iterable<GuardableSession | undefined> }
  }
}

/** Injectable environment, so the repair can be driven turn by turn in tests. */
export interface SessionOpenGuardOptions {
  /** The app's `sessions` service, resolved lazily: it may register after mount. */
  sessions: () => unknown
  endpoint?: string
  send?: (endpoint: string, payload: string) => void
  now?: () => number
  setTimeout?: (callback: () => void, ms: number) => number
  clearTimeout?: (handle: number) => void
  setInterval?: (callback: () => void, ms: number) => number
  clearInterval?: (handle: number) => void
  noFrameMs?: number
  maxRepairs?: number
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
  const telemetryLimit = options.telemetryLimit ?? SESSION_OPEN_GUARD_TELEMETRY_LIMIT
  const armIntervalMs = options.armIntervalMs ?? SESSION_OPEN_GUARD_ARM_INTERVAL_MS
  const armAttempts = options.armAttempts ?? SESSION_OPEN_GUARD_ARM_ATTEMPTS

  /** Sessions this guard has actually seen, for the invalidation diagnosis. */
  const known = new WeakSet<object>()
  /** Stranded repairs spent, per sessionId, for this page load. */
  const repairs = new Map<string, number>()
  /** Sessions already asked to `resync()`, per page load. */
  const resynced = new Set<string>()
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
      }
      sent += 1
      send(endpoint, JSON.stringify(record))
    } catch {
      // Telemetry must never surface as an error, and never disturb a repair.
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
    })
  }

  /**
   * The stale-return strand: the pass settled, the state is still `"loading"`,
   * and no open is scheduled. Repairing means clearing the promise the settled
   * pass already cleared (so `open()` cannot return it) and asking the app to
   * open again on the carrier that is up.
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
    if (!isStaleOpenPromise(session, pass)) return
    if (session.open === undefined) return
    const spent = repairs.get(sessionId) ?? 0
    if (spent >= maxRepairs) return
    repairs.set(sessionId, spent + 1)
    loadingSince.set(sessionId, now())
    const mode = modeOf(session)
    report('stranded', sessionId, now() - startedAt, {
      ...(mode === undefined ? {} : { mode }),
      repairs: spent + 1,
    })
    session.openPromise = null
    session.open()
  }

  /**
   * Wrap one prototype. Re-installs are no-ops: the prototype carries a hidden
   * mark, and the wrapper is shared by every instance the app builds afterwards.
   * @param prototype - The session class' prototype.
   * @returns One when this call wrapped it, zero when it was already wrapped.
   */
  const wrapPrototype = (prototype: object): number => {
    if ((prototype as Record<string, unknown>)[PROTOTYPE_MARK] === true) return 0
    const methods = prototype as { doOpen?: unknown; dispose?: unknown; resync?: unknown }
    const originalDoOpen = methods.doOpen
    if (typeof originalDoOpen !== 'function') return 0
    const openPass = originalDoOpen as GuardMethod
    const originalDispose = typeof methods.dispose === 'function' ? (methods.dispose as GuardMethod) : undefined
    const originalResync = typeof methods.resync === 'function' ? (methods.resync as GuardMethod) : undefined

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
            if (resynced.has(sessionId)) return
            resynced.add(sessionId)
            resyncedThisPass = true
            const mode = modeOf(session)
            report('no-frame', sessionId, now() - startedAt, {
              ...(mode === undefined ? {} : { mode }),
              resyncs: 1,
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

  return stopArming
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
