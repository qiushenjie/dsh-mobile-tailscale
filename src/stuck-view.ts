/**
 * Watching the conversation view for the host's history placeholder.
 *
 * 「载入历史…」 is the host's own `chat.loadingHistory` hint, shown while a
 * session opens. It is meant to be momentary: the opening window is published by
 * the `session/follow` stream. Measured on the live app, when that stream's
 * snapshot frame never arrives the hint stays up forever — the app never
 * retries, shows no error, and the HTTP history page behind it looks perfectly
 * healthy. Nothing in the stack recovers by itself.
 *
 * So the plugin watches for that hint. After a few seconds it reports what the
 * page looks like, closes the app's sockets so the connection layer rebuilds
 * the stream (the measured recovery), and — if the view is still stuck —
 * reloads the page, rate limited so a slow open cannot become a reload loop.
 *
 * The gentle path is gated on the mechanism, not on the symptom: a socket is
 * only closed when one of the app's own `session/follow` opens is still waiting
 * for its snapshot frame. A slow-but-working open keeps receiving frames, and
 * killing its carrier would interrupt it for nothing, so that case goes
 * straight to the (rate limited) reload ladder.
 */

import { pageFetchStats, type PageFetchStats } from './page-fetch-guard.js'
import { TELEMETRY_ENDPOINT } from './page-timing.js'
import { openingWindowMissing, reconnectSockets, socketWatchStats, type SocketWatchStats } from './socket-watch.js'

/** How long the hint must stay up before the view counts as stuck. */
export const STUCK_VIEW_DELAY_MS = 3_000

/** How long a rebuilt carrier gets to republish the conversation. */
export const STUCK_VIEW_RECOVERY_MS = 6_000

/** How often the hint is looked for. */
export const STUCK_VIEW_POLL_MS = 1_000

/** Reloads allowed inside the window, across page loads. */
export const STUCK_VIEW_RELOAD_LIMIT = 3

/** Sliding window for the reload limit. */
export const STUCK_VIEW_RELOAD_WINDOW_MS = 300_000

/** Key holding the reload timestamps, so the limit survives a reload. */
export const STUCK_VIEW_STORAGE_KEY = 'dsh-mobile.stuck-view.reloads'

/** Turns, for the report: how much of the conversation is actually on screen. */
export const STUCK_VIEW_TURN_SELECTOR = '[data-chat-turn]'

/**
 * The host renders its placeholder from these locale strings; a match means the
 * view is still waiting for an opening window, not that the session is empty.
 */
const HINT_TEXTS = ['载入历史', 'loading history']

/** The element shape the hint search needs, so a test double is enough. */
export interface StuckViewElement {
  childElementCount?: number
  textContent?: string | null
}

/** The document shape the hint search needs, so a test double is enough. */
export interface StuckViewDocument {
  visibilityState?: string
  querySelectorAll(selector: string): ArrayLike<StuckViewElement>
}

/** Storage shape for the reload limit. */
export interface StuckViewStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** What the watch was doing when it reported. */
export type StuckViewPhase = 'detected' | 'reconnect' | 'reload' | 'recovered' | 'gave-up'

/** One report about a view that would not open. */
export interface StuckViewRecord {
  kind: 'stuck-view'
  at: string
  phase: StuckViewPhase
  /** How long the hint had been up when this phase ran. */
  stuckMs: number
  hint: string | null
  turns: number | null
  hidden: boolean
  online: boolean
  sockets: SocketWatchStats | null
  pageFetch: PageFetchStats | null
}

/** Injectable environment for the watch. */
export interface StuckViewHost {
  document?: StuckViewDocument
  location?: { reload: () => void }
  storage?: StuckViewStorage
  now?: () => number
  setInterval?: (callback: () => void, ms: number) => number
  clearInterval?: (handle: number) => void
  send?: (endpoint: string, payload: string) => void
  endpoint?: string
  sockets?: () => SocketWatchStats | undefined
  pageStats?: () => PageFetchStats | undefined
  /** True when an observed open is still missing its opening window. */
  carrierStalled?: () => boolean
  reconnect?: (reason: string) => number
  turns?: () => number
  online?: () => boolean
  delayMs?: number
  recoveryMs?: number
  pollMs?: number
  reloadLimit?: number
  reloadWindowMs?: number
}

/**
 * The host's placeholder, when one is on screen.
 * @param doc - The document to search.
 * @returns The hint's own text, or null when the view is not waiting.
 */
export function stuckHintOf(doc: StuckViewDocument): string | null {
  const nodes = doc.querySelectorAll('div, span, p')
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node === undefined) continue
    if ((node.childElementCount ?? 0) > 0) continue
    const text = (node.textContent ?? '').trim()
    if (text.length === 0 || text.length > 64) continue
    const lowered = text.toLowerCase()
    for (const hint of HINT_TEXTS) {
      if (lowered.includes(hint)) return text
    }
  }
  return null
}

/**
 * Watch for a conversation that never opens, and recover it.
 * @param host - Injectable document, clock, telemetry, and recovery hooks.
 * @returns A function that stops watching.
 */
export function installStuckViewWatch(host: StuckViewHost = {}): () => void {
  const doc = host.document ?? (typeof document === 'undefined' ? undefined : (document as unknown as StuckViewDocument))
  if (doc === undefined) return () => undefined
  const now = host.now ?? ((): number => Date.now())
  const delayMs = host.delayMs ?? STUCK_VIEW_DELAY_MS
  const recoveryMs = host.recoveryMs ?? STUCK_VIEW_RECOVERY_MS
  const pollMs = host.pollMs ?? STUCK_VIEW_POLL_MS
  const reloadLimit = host.reloadLimit ?? STUCK_VIEW_RELOAD_LIMIT
  const reloadWindowMs = host.reloadWindowMs ?? STUCK_VIEW_RELOAD_WINDOW_MS
  const endpoint = host.endpoint ?? TELEMETRY_ENDPOINT
  const sockets = host.sockets ?? socketWatchStats
  const pageStats = host.pageStats ?? pageFetchStats
  const reconnect = host.reconnect ?? reconnectSockets
  const stalled = host.carrierStalled ?? ((): boolean => openingWindowMissing(sockets()))
  const turns = host.turns ?? ((): number => doc.querySelectorAll(STUCK_VIEW_TURN_SELECTOR).length)
  const storage = host.storage ?? defaultStorage()
  const reload = host.location?.reload ?? ((): void => {
    if (typeof location !== 'undefined') location.reload()
  })
  const schedule = host.setInterval
    ?? ((callback: () => void, ms: number): number => globalThis.setInterval(callback, ms) as unknown as number)
  const unschedule = host.clearInterval
    ?? ((handle: number): void => globalThis.clearInterval(handle as unknown as ReturnType<typeof globalThis.setInterval>))
  const online = host.online ?? ((): boolean => typeof navigator === 'undefined' || navigator.onLine !== false)
  const send = host.send ?? defaultSend

  let stuckSince: number | null = null
  let reported = false
  let reconnectAt: number | null = null
  let gaveUp = false

  const report = (phase: StuckViewPhase, stuckMs: number, hint: string | null): void => {
    const record: StuckViewRecord = {
      kind: 'stuck-view',
      at: new Date(now()).toISOString(),
      phase,
      stuckMs,
      hint,
      turns: turns(),
      hidden: doc.visibilityState === 'hidden',
      online: online(),
      sockets: sockets() ?? null,
      pageFetch: pageStats() ?? null,
    }
    send(endpoint, JSON.stringify(record))
  }

  const recentReloads = (): number[] => {
    if (storage === undefined) return []
    let stored: unknown
    try {
      stored = JSON.parse(storage.getItem(STUCK_VIEW_STORAGE_KEY) ?? '[]')
    } catch {
      return []
    }
    if (!Array.isArray(stored)) return []
    const at = now()
    return stored.filter((value): value is number => typeof value === 'number' && at - value < reloadWindowMs)
  }

  const escalate = (stuckMs: number, hint: string): void => {
    if (gaveUp) return
    const attempts = recentReloads()
    if (attempts.length >= reloadLimit) {
      gaveUp = true
      report('gave-up', stuckMs, hint)
      return
    }
    attempts.push(now())
    try {
      storage?.setItem(STUCK_VIEW_STORAGE_KEY, JSON.stringify(attempts))
    } catch {
      // Private browsing may refuse the write; the reload still gets its chance.
    }
    report('reload', stuckMs, hint)
    try {
      reload()
    } catch {
      // The page is going away either way.
    }
  }

  const tick = (): void => {
    const hint = stuckHintOf(doc)
    if (hint === null || doc.visibilityState === 'hidden') {
      if (hint === null) {
        if (reported && reconnectAt !== null) report('recovered', now() - (stuckSince ?? now()), null)
        stuckSince = null
        reported = false
        reconnectAt = null
        gaveUp = false
      }
      return
    }
    if (stuckSince === null) {
      stuckSince = now()
      return
    }
    const stuckMs = now() - stuckSince
    if (stuckMs < delayMs) return
    if (!reported) {
      reported = true
      report('detected', stuckMs, hint)
    }
    if (reconnectAt === null) {
      reconnectAt = now()
      // Only a carrier that provably lost its opening frame is worth closing.
      if (!stalled()) return
      const closed = reconnect('stuck-view')
      report('reconnect', stuckMs, hint)
      // Nothing to rebuild: the reload is the only lever left.
      if (closed === 0) escalate(stuckMs, hint)
      return
    }
    if (now() - reconnectAt >= recoveryMs) escalate(stuckMs, hint)
  }

  const handle = schedule(tick, pollMs)
  return () => {
    unschedule(handle)
  }
}

/**
 * Local storage, when the page has it.
 * @returns The store, or undefined outside a document.
 */
function defaultStorage(): StuckViewStorage | undefined {
  if (typeof localStorage === 'undefined') return undefined
  return localStorage
}

/**
 * Post one report, without ever re-entering the plugin's own guards.
 * @param endpoint - Telemetry URL.
 * @param payload - Serialized record.
 */
function defaultSend(endpoint: string, payload: string): void {
  void fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => undefined)
}
