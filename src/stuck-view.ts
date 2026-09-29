/**
 * Watching the conversation view for the host's history placeholder.
 *
 * 「载入历史…」 is the host's own `chat.loadingHistory` hint, shown while a
 * session opens. It is meant to be momentary: the opening window is published by
 * the `session/follow` stream. Measured on the live app, when that stream's
 * snapshot frame never arrives the hint stays up and the app never retries,
 * shows no error, and the HTTP history page behind it looks perfectly healthy.
 *
 * The first version of this watch searched the whole document for any leaf whose
 * text merely *contained* 「载入历史」. That matched the conversation itself — a
 * message that talks about the hint — so a perfectly healthy session was
 * reported as stuck, its sockets were closed and the page reloaded, which spent
 * the reload budget until a real stall met a watchdog that had already given up
 * (observed on the device: `detected` at 28 and 49 turns, then `gave-up` on the
 * stall that mattered). The detector is now the host's placeholder element
 * itself — the `hint` class of the conversation CSS module — and every action
 * additionally requires an actually empty conversation, so nothing here can fire
 * on a view that is showing content.
 *
 * The recovery that works is the one the device showed: closing the app's mux
 * socket makes the connection layer rebuild its generation, which re-opens
 * `session/follow` and publishes the window about a second later. On the device
 * the hint sat on screen for 5-20 s before that happened, because the watch
 * waited 15 s to act; the HTTP page behind it had already answered in
 * milliseconds. So the watch now acts as soon as the placeholder is clearly not
 * momentary — the host's own hint element, an empty conversation, 2 s — and
 * retries the rebuild in quick succession (2 s, 3.2 s, 5 s, 8 s into the stall),
 * because the device showed the second replacement carrier as the one that
 * actually recovered the view. A reload stays the
 * last resort at 30 s, once per ten minutes, never while the page is hidden or
 * offline: it is visible (the shell paints before the remembered session opens)
 * while the socket rebuild is not.
 */

import { pageFetchStats, type PageFetchStats } from './page-fetch-guard.js'
import { TELEMETRY_ENDPOINT } from './page-timing.js'
import { openingWindowMissing, reconnectSockets, socketWatchStats, type SocketWatchStats } from './socket-watch.js'

/**
 * How long an empty conversation may show the hint before the watch acts.
 *
 * A healthy open publishes the window within a few hundred milliseconds of the
 * page answering; a device measured 1-6 s for a slow one. Two seconds is long
 * enough to leave an ordinary open alone and short enough that a stall costs a
 * blink rather than a stare.
 */
export const STUCK_VIEW_DELAY_MS = 2_000

/**
 * How long after the stall began each rebuild runs, offset by the detection delay.
 *
 * Dense at the front on purpose. On the device the rebuild that recovered the
 * view was the *second* one — a first replacement carrier published its own
 * `session/follow` snapshot and the app still sat in its loading state — and each
 * rebuild costs the app a full re-subscription (7-11 s on the device), so the
 * earlier that second chance arrives the better.
 */
export const STUCK_VIEW_RECONNECT_GAPS_MS: readonly number[] = [0, 1_200, 3_000, 6_000]

/** Rebuilds allowed before only the reload is left. */
export const STUCK_VIEW_MAX_RECONNECTS = STUCK_VIEW_RECONNECT_GAPS_MS.length

/**
 * How long the app's own re-open gets before carriers start being rebuilt.
 *
 * `resync()` answers over the carrier that is already open when the host is
 * healthy, so this is a blink; it only has to outlast one poll plus the round
 * trip.
 */
export const STUCK_VIEW_RESYNC_GRACE_MS = 1_000

/** How long a rebuilt carrier gets before the page is reloaded. */
export const STUCK_VIEW_RELOAD_AFTER_MS = 30_000

/** How often the hint is looked for. */
export const STUCK_VIEW_POLL_MS = 500

/** Reloads allowed inside the window, across page loads. */
export const STUCK_VIEW_RELOAD_LIMIT = 1

/** Sliding window for the reload limit. */
export const STUCK_VIEW_RELOAD_WINDOW_MS = 600_000

/** Key holding the reload timestamps, so the limit survives a reload. */
export const STUCK_VIEW_STORAGE_KEY = 'dsh-mobile.stuck-view.reloads'

/** Turns, for the report: how much of the conversation is actually on screen. */
export const STUCK_VIEW_TURN_SELECTOR = '[data-chat-turn]'

/**
 * The host's placeholder class. ChatView renders `.hint` from its CSS module, so
 * the class in the built app is `_hint_<hash>`; the pattern also accepts a plain
 * `hint` class so the match survives a different module setup.
 */
const HINT_CLASS_PATTERN = /(^|[^a-z])hint([^a-z]|$)/i

/**
 * The exact strings the host renders for that class. Kept for the record and as
 * a locale-independent fallback: a `hint`-classed leaf is the placeholder only
 * when it is short, and these are the texts the host puts there.
 */
const HINT_TEXTS = ['载入历史…', 'loading history…']

/** Longest text a placeholder may hold; keeps prose out of the match. */
const HINT_TEXT_LIMIT = 32

/** The element shape the hint search needs, so a test double is enough. */
export interface StuckViewElement {
  childElementCount?: number
  textContent?: string | null
  className?: string
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
export type StuckViewPhase = 'detected' | 'resync' | 'reconnect' | 'reload' | 'recovered' | 'gave-up'

/** One report about a view that would not open. */
export interface StuckViewRecord {
  kind: 'stuck-view'
  at: string
  phase: StuckViewPhase
  /** How long the placeholder had been up when this phase ran. */
  stuckMs: number
  hint: string | null
  turns: number | null
  hidden: boolean
  online: boolean
  /** True when an open `session/follow` is still missing its opening frame. */
  stalled: boolean
  /** Rebuild number within this stall, on `reconnect`. */
  attempt?: number
  /** Sockets the rebuild closed, on `reconnect`. */
  closed?: number
  /** Sessions the app was asked to re-open, on `resync`. */
  resynced?: number
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
  reconnect?: (reason: string) => number
  turns?: () => number
  online?: () => boolean
  stalled?: () => boolean
  delayMs?: number
  /**
   * Ask the app to re-open sessions it reports as loading. Returns how many it
   * was asked to re-open; zero means the socket rebuild should start at once.
   */
  softResync?: () => number
  reconnectGapsMs?: readonly number[]
  maxReconnects?: number
  reloadAfterMs?: number
  pollMs?: number
  reloadLimit?: number
  reloadWindowMs?: number
}

/**
 * The host's placeholder, when one is on screen.
 *
 * Only the conversation's own hint element counts: a leaf carrying the host's
 * `hint` class with short text. Conversation content that happens to mention the
 * hint's wording has no such class and is ignored.
 * @param doc - The document to search.
 * @returns The hint's own text, or null when the placeholder is not up.
 */
export function stuckHintOf(doc: StuckViewDocument): string | null {
  const nodes = doc.querySelectorAll('div, span, p')
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node === undefined) continue
    if ((node.childElementCount ?? 0) > 0) continue
    const className = typeof node.className === 'string' ? node.className : ''
    if (!HINT_CLASS_PATTERN.test(className)) continue
    const text = (node.textContent ?? '').trim()
    if (text.length === 0 || text.length > HINT_TEXT_LIMIT) continue
    return text
  }
  return null
}

/**
 * Whether the text is one of the host's own placeholder strings.
 * @param text - Candidate hint text.
 * @returns True for the known loading strings.
 */
export function isPlaceholderText(text: string): boolean {
  const lowered = text.trim().toLowerCase()
  return HINT_TEXTS.some((hint) => lowered === hint.toLowerCase())
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
  const softResync = host.softResync
  const reconnectGaps = host.reconnectGapsMs ?? STUCK_VIEW_RECONNECT_GAPS_MS
  const maxReconnects = host.maxReconnects ?? STUCK_VIEW_MAX_RECONNECTS
  const reloadAfterMs = host.reloadAfterMs ?? STUCK_VIEW_RELOAD_AFTER_MS
  const pollMs = host.pollMs ?? STUCK_VIEW_POLL_MS
  const reloadLimit = host.reloadLimit ?? STUCK_VIEW_RELOAD_LIMIT
  const reloadWindowMs = host.reloadWindowMs ?? STUCK_VIEW_RELOAD_WINDOW_MS
  const endpoint = host.endpoint ?? TELEMETRY_ENDPOINT
  const sockets = host.sockets ?? socketWatchStats
  const pageStats = host.pageStats ?? pageFetchStats
  const reconnect = host.reconnect ?? reconnectSockets
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
  const stalled = host.stalled ?? ((): boolean => openingWindowMissing(sockets()))
  const send = host.send ?? defaultSend

  let stuckSince: number | null = null
  let reported = false
  let reconnects = 0
  let nextReconnectAt = 0
  let gaveUp = false
  let softResynced = false

  const report = (
    phase: StuckViewPhase,
    stuckMs: number,
    hint: string | null,
    extra: { attempt?: number; closed?: number; resynced?: number } = {},
  ): void => {
    const record: StuckViewRecord = {
      kind: 'stuck-view',
      at: new Date(now()).toISOString(),
      phase,
      stuckMs,
      hint,
      turns: turns(),
      hidden: doc.visibilityState === 'hidden',
      online: online(),
      stalled: stalled(),
      sockets: sockets() ?? null,
      pageFetch: pageStats() ?? null,
    }
    if (extra.attempt !== undefined) record.attempt = extra.attempt
    if (extra.closed !== undefined) record.closed = extra.closed
    if (extra.resynced !== undefined) record.resynced = extra.resynced
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

  const reset = (): void => {
    stuckSince = null
    reported = false
    reconnects = 0
    nextReconnectAt = 0
    gaveUp = false
    softResynced = false
  }

  const tick = (): void => {
    const hint = stuckHintOf(doc)
    // A hidden page is neither stuck nor recovered: it is simply not being
    // watched, so the clock restarts when it comes back to the foreground.
    if (doc.visibilityState === 'hidden') {
      reset()
      return
    }
    // A view that is showing turns is not stuck, whatever else is on screen.
    if (hint === null || turns() > 0) {
      if (hint === null && reported) report('recovered', now() - (stuckSince ?? now()), null)
      reset()
      return
    }
    if (stuckSince === null) {
      stuckSince = now()
      nextReconnectAt = delayMs
      return
    }
    const stuckMs = now() - stuckSince
    if (reconnects === 0 && stuckMs < delayMs) return
    if (!reported) {
      reported = true
      report('detected', stuckMs, hint)
    }
    // Without a network there is nothing to rebuild and no page to reload.
    if (!online()) return
    // The app's own retry first: re-opening on the carrier that is already up
    // costs a round trip, while rebuilding carriers costs the app every
    // subscription it holds (measured at 7-11 s on the device).
    if (!softResynced) {
      softResynced = true
      const resynced = softResync?.() ?? 0
      if (resynced > 0) {
        report('resync', stuckMs, hint, { resynced })
        nextReconnectAt = delayMs + STUCK_VIEW_RESYNC_GRACE_MS
        return
      }
    }
    if (reconnects < maxReconnects && stuckMs >= nextReconnectAt) {
      reconnects += 1
      // 2 s, then 3.2 s, 5 s and 8 s into the stall: the second rebuild is the
      // one the device showed recovering the view, so it must not be far behind
      // the first.
      const gap = reconnectGaps[reconnects] ?? reconnectGaps[reconnectGaps.length - 1] ?? 0
      nextReconnectAt = delayMs + gap
      const closed = reconnect('stuck-view')
      report('reconnect', stuckMs, hint, { attempt: reconnects, closed })
      // Nothing to rebuild: the reload is the only lever left.
      if (closed === 0) escalate(stuckMs, hint)
      return
    }
    if (reconnects >= maxReconnects && stuckMs >= reloadAfterMs) escalate(stuckMs, hint)
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
