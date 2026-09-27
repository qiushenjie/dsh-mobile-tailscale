/**
 * Retry the phone's history page request when it stalls.
 *
 * The host's RPC layer calls `fetch` without a signal and with no timeout
 * anywhere in the stack, so a page POST that dies on a half-open socket —
 * screen off, a network change, the tailnet re-keying — never settles. The
 * session controller awaits that promise and only then leaves
 * `openState === 'loading'`, the state that renders "载入历史…". Measured on
 * the phone: seven history page POSTs around one blank conversation left no
 * server-side record at all (the proxy only records a page once the phone has
 * drained it) while the view never painted a single turn, and the phone's own
 * timeline only became readable twenty minutes later.
 *
 * The page call is a read-only, idempotent RPC whose body is a JSON string, so
 * a request that produced no response inside the deadline can be replayed on a
 * fresh connection. This module wraps `globalThis.fetch` for that endpoint
 * only. The host reads the global at call time — a real browser confirms a
 * wrapper installed long after boot still observes the app's page calls — and
 * every other request is handed through untouched.
 */
import { PAGE_TIMING_PATH, TELEMETRY_ENDPOINT } from './page-timing.js'

/**
 * How long the headers of one attempt may take.
 *
 * The app answers a history page in single-digit milliseconds on the LAN and
 * the phone received those answers in the same tick, so a first byte that has
 * not arrived in eight seconds is a dead request, not a slow one.
 */
export const PAGE_FETCH_HEADERS_TIMEOUT_MS = 8_000

/**
 * How long one attempt's body may take once the headers arrived.
 *
 * A 24-message page is a few hundred kilobytes over the tailnet; the deadline
 * only exists so a body that stops mid-stream cannot hang the session view.
 */
export const PAGE_FETCH_BODY_TIMEOUT_MS = 20_000

/** Attempts per page call: the original plus two replays. */
export const PAGE_FETCH_ATTEMPTS = 3

/** Base delay between instead of hammering a link that is coming back. */
export const PAGE_FETCH_RETRY_DELAY_MS = 250

/** How a page call ended. `aborted` is the app cancelling, not a stall. */
export type PageFetchOutcome = 'ok' | 'timeout' | 'error' | 'aborted'

/** One page call as the phone saw it. */
export interface PageFetchRecord {
  readonly kind: 'page-fetch'
  readonly at: string
  readonly path: string
  readonly attempts: number
  readonly outcome: PageFetchOutcome
  /** Wall time across every attempt. */
  readonly ms: number
  readonly status: number | null
  readonly requestBytes: number
  /** Decoded bytes of the last attempt that produced a body. */
  readonly responseBytes: number
  /** Whether the page was in the background while this call ran. */
  readonly hidden: boolean
  readonly online: boolean
  readonly error: string | null
}

/** A global object that carries `fetch` (injectable for tests). */
export interface FetchHost {
  fetch?: typeof globalThis.fetch
}

/** Injectable environment for {@link installPageFetchGuard}. */
export interface PageFetchGuardOptions {
  /** The global to patch; defaults to the real one. */
  readonly host?: FetchHost
  /** The original implementation; defaults to `host.fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /** Endpoint to guard, by pathname. */
  readonly endpoint?: string
  readonly headersTimeoutMs?: number
  readonly bodyTimeoutMs?: number
  readonly attempts?: number
  readonly retryDelayMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly send?: (endpoint: string, body: string) => void
  readonly telemetryEndpoint?: string
  /** Whether the document is hidden (injectable for tests). */
  readonly hidden?: () => boolean
  readonly online?: () => boolean
}

/**
 * Path of the request target, whatever shape the caller passed.
 * @param input - The fetch target (string, URL, or Request).
 * @param base - Origin to resolve a relative target against.
 * @returns The pathname, or undefined when it cannot be read.
 */
export function requestPathOf(input: unknown, base?: string): string | undefined {
  const raw = ((): string | undefined => {
    if (typeof input === 'string') return input
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href
    if (typeof Request !== 'undefined' && input instanceof Request) return input.url
    const candidate = (input as { url?: unknown } | null | undefined)?.url
    return typeof candidate === 'string' ? candidate : undefined
  })()
  if (raw === undefined) return undefined
  const origin = base ?? (typeof location === 'undefined' ? undefined : location.href)
  if (origin === undefined) {
    // No document to resolve against: an absolute target still has a path.
    try {
      return new URL(raw).pathname
    } catch {
      return raw.split('?')[0]
    }
  }
  try {
    return new URL(raw, origin).pathname
  } catch {
    return undefined
  }
}

/**
 * Whether this call is the app pulling one history page.
 *
 * Only a POST counts: the same path also serves other verbs, and a request the
 * plugin cannot describe is not a request it should replay.
 * @param input - The fetch target.
 * @param init - The fetch init.
 * @param endpoint - Pathname to match.
 * @returns True when the call is one history page read.
 */
export function isHistoryPageRequest(
  input: unknown,
  init?: { readonly method?: string },
  endpoint: string = PAGE_TIMING_PATH,
): boolean {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'POST') return false
  const path = requestPathOf(input)
  if (path === undefined) return false
  // A target the environment could not resolve against an origin (`location`
  // is missing) still reads as the same endpoint.
  return stripLeadingSlash(path) === stripLeadingSlash(endpoint)
}

/**
 * Drop one leading slash so a resolved and an unresolved path compare equal.
 * @param path - A pathname.
 * @returns The pathname without its leading slash.
 */
function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path
}

/**
 * Install the retrying wrapper.
 * @param options - Injectable transport, clock, and telemetry.
 * @returns A function that puts the original `fetch` back.
 */
export function installPageFetchGuard(options: PageFetchGuardOptions = {}): () => void {
  const host = options.host ?? (globalThis as FetchHost)
  const real = options.fetch ?? host.fetch
  if (typeof real !== 'function') return () => undefined
  const endpoint = options.endpoint ?? PAGE_TIMING_PATH
  const headersTimeoutMs = options.headersTimeoutMs ?? PAGE_FETCH_HEADERS_TIMEOUT_MS
  const bodyTimeoutMs = options.bodyTimeoutMs ?? PAGE_FETCH_BODY_TIMEOUT_MS
  const attempts = Math.max(1, Math.trunc(options.attempts ?? PAGE_FETCH_ATTEMPTS))
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? PAGE_FETCH_RETRY_DELAY_MS)
  const now = options.now ?? ((): number => Date.now())
  const sleep = options.sleep ?? wait
  const telemetryEndpoint = options.telemetryEndpoint ?? TELEMETRY_ENDPOINT
  const hidden = options.hidden ?? ((): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden')
  const online = options.online ?? ((): boolean => typeof navigator === 'undefined' || navigator.onLine !== false)
  const send = options.send ?? ((url: string, payload: string): void => {
    // Posted through the original `fetch`, so telemetry can never re-enter the
    // wrapper and a failed report stays invisible to the app.
    void real.call(host, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => undefined)
  })

  const report = (record: PageFetchRecord): void => {
    send(telemetryEndpoint, JSON.stringify(record))
  }

  const replay = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    body: string,
  ): Promise<Response> => {
    const startedAt = now()
    const caller = init?.signal ?? undefined
    const path = requestPathOf(input) ?? endpoint
    let attempt = 0
    let outcome: PageFetchOutcome = 'error'
    let status: number | null = null
    let responseBytes = 0
    let error: string | null = null
    let lastError: unknown
    while (attempt < attempts) {
      attempt += 1
      if (isAborted(caller)) {
        report({ kind: 'page-fetch', at: new Date().toISOString(), path, attempts: attempt - 1, outcome: 'aborted', ms: now() - startedAt, status, requestBytes: body.length, responseBytes, hidden: hidden(), online: online(), error: 'aborted before attempt' })
        throw abortReason(caller)
      }
      const controller = new AbortController()
      const forward = (): void => controller.abort()
      caller?.addEventListener('abort', forward)
      let stalled = false
      try {
        const headersTimer = setTimeout(() => {
          stalled = true
          controller.abort()
        }, headersTimeoutMs)
        let response: Response
        try {
          response = await real.call(host, input, { ...init, signal: controller.signal })
        } finally {
          clearTimeout(headersTimer)
        }
        status = response.status
        const bodyTimer = setTimeout(() => {
          stalled = true
          controller.abort()
        }, bodyTimeoutMs)
        let buffer: ArrayBuffer
        try {
          buffer = await response.arrayBuffer()
        } finally {
          clearTimeout(bodyTimer)
        }
        responseBytes = buffer.byteLength
        outcome = 'ok'
        error = null
        if (attempt > 1) {
          report({ kind: 'page-fetch', at: new Date().toISOString(), path, attempts: attempt, outcome, ms: now() - startedAt, status, requestBytes: body.length, responseBytes, hidden: hidden(), online: online(), error: null })
        }
        return synthesize(response, buffer)
      } catch (failure) {
        lastError = failure
        if (isAborted(caller)) outcome = 'aborted'
        else if (stalled) outcome = 'timeout'
        else outcome = 'error'
        error = describe(failure)
      } finally {
        caller?.removeEventListener('abort', forward)
      }
      if (outcome === 'aborted') {
        report({ kind: 'page-fetch', at: new Date().toISOString(), path, attempts: attempt, outcome, ms: now() - startedAt, status, requestBytes: body.length, responseBytes, hidden: hidden(), online: online(), error })
        throw lastError
      }
      if (attempt < attempts) await sleep(retryDelayMs * attempt)
    }
    report({ kind: 'page-fetch', at: new Date().toISOString(), path, attempts, outcome, ms: now() - startedAt, status, requestBytes: body.length, responseBytes, hidden: hidden(), online: online(), error })
    throw lastError
  }

  const guarded = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body
    // Only a JSON string body can be replayed; anything else (a stream, a
    // request object) goes through exactly as before.
    if (typeof body !== 'string' || !isHistoryPageRequest(input, init, endpoint)) {
      return real.call(host, input, init)
    }
    return replay(input, init, body)
  }
  host.fetch = guarded
  return () => {
    if (host.fetch === guarded) host.fetch = real
  }
}

/**
 * Rebuild the response from the bytes already read.
 *
 * The body was consumed to cover a stall that happens after the headers, and
 * the caller only ever reads `ok`/`status`/`json()` from it, so an equivalent
 * response keeps the app's behaviour identical.
 * @param source - The response the transport produced.
 * @param buffer - Its decoded body.
 * @returns A response carrying the same status, headers, and bytes.
 */
function synthesize(source: Response, buffer: ArrayBuffer): Response {
  const init: ResponseInit = { status: source.status, statusText: source.statusText, headers: source.headers }
  if (source.status === 204 || source.status === 304) return new Response(null, init)
  return new Response(buffer, init)
}

/**
 * Whether the app has already cancelled this call.
 *
 * Read through a helper so control-flow narrowing from an earlier check cannot
 * make the second read look impossible.
 * @param signal - The caller's signal, when it passed one.
 * @returns True once the caller has aborted.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * An abort error shaped like the one the transport raises.
 * @param signal - The caller's aborted signal.
 * @returns The reason to reject with.
 */
function abortReason(signal: AbortSignal | undefined): unknown {
  if (signal !== undefined && signal.reason !== undefined) return signal.reason
  return typeof DOMException === 'function'
    ? new DOMException('The operation was aborted.', 'AbortError')
    : new Error('The operation was aborted.')
}

/**
 * A short, log-safe description of a failure.
 * @param failure - Whatever was thrown.
 * @returns A string for the telemetry record.
 */
function describe(failure: unknown): string {
  if (failure instanceof Error) return `${failure.name}: ${failure.message}`.slice(0, 200)
  return String(failure).slice(0, 200)
}

/**
 * Wait.
 * @param ms - Milliseconds.
 * @returns A promise resolved after the delay.
 */
function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
