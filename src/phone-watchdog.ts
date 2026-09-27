/**
 * Phone-side session watchdog.
 *
 * The remote channel is a long-lived WebSocket multiplexer. When the phone's
 * link dies without the browser noticing (Tailscale suspended, radio handover,
 * a page restored from the back/forward cache) the multiplexer is dead but its
 * socket still reads OPEN, and the chat view keeps its "loading history" hint
 * up forever: the request is neither answered nor rejected, so DSH never
 * renders its error path.
 *
 * DSH cannot repair that on its own. `RemoteStreamMuxClient` connects only when
 * something calls `maintain()` (from `start()`/`reconnect()`), and the mux
 * "owns no independent retry schedule": it is replaced only when the Connection
 * controller starts a new generation. A half-open socket never fails, so no
 * generation ever retries -- and closing the socket ourselves is not enough
 * either, because nothing would call `maintain()` afterwards. The supported
 * recovery is `ctx.connection.reconnect()`: it aborts the active generation and
 * starts retry 1 immediately, which asks the Gateway for a fresh multiplexer.
 *
 * This module runs inside the phone page (client bundle, so a page refresh is
 * enough to deploy it) and:
 *
 * 1. records what the page is actually waiting for -- mux frames with their
 *    endpoint, request window and byte size, socket state, in-flight requests;
 * 2. asks DSH to rebuild the connection when the hint is up and the
 *    multiplexer has gone quiet, doubling the wait between attempts;
 * 3. if that does not help, reloads the page and shows a diagnostic sheet the
 *    user can screenshot, with buttons to reconnect or reload immediately.
 *
 * A stall is only ever diagnosed from two things at once: the chat view's *own*
 * status node is up, and nothing has arrived on the multiplexer for several
 * seconds. Reading the transcript for the hint text does not work -- the
 * conversation itself contains those words as soon as anyone discusses this
 * feature, so a text scan reports a stall on a perfectly healthy page and then
 * "recovers" it by reconnecting and reloading under the reader.
 */

const HISTORY_LOADING_TEXT = '载入历史'
/** Chat view status nodes, matched by CSS-module suffix so a rebuild's hash change does not hide them. */
const HISTORY_HINT_SUFFIXES: readonly string[] = ['_hint']
const HISTORY_ERROR_SUFFIXES: readonly string[] = ['_openError']
const POLL_MS = 2_000
/** No multiplexer traffic for this long, with the hint up, counts as a stall. */
const IDLE_AFTER_MS = 5_000
const SHEET_AFTER_MS = 8_000
/** First recovery attempt after the stall starts; later attempts double their wait. */
const HEAL_AFTER_MS = 6_000
const HEAL_GROWTH = 2
const HEAL_MAX_GAP_MS = 60_000
const RELOAD_AFTER_MS = 30_000
const RELOAD_GUARD_KEY = 'dsh-mobile-watchdog-reloaded'
const RELOAD_GUARD_MS = 60_000
/** Coming back after at least this long hidden is treated as a suspect link. */
const RESUME_HIDE_MS = 10_000
const MAX_PENDING_SHOWN = 4
const MAX_NOTES_SHOWN = 3
const MAX_FRAME_NOTES = 8

/** Endpoint names that speak over the multiplexed remote channel. */
const MUX_URL_MARKER = 'mux'

/** Ask DSH to rebuild its gateway connection; `false` when no handle is reachable. */
export type HealConnection = () => boolean

export interface PhoneWatchdogOptions {
  /** DSH's `connection.reconnect()`, wired by the client plugin. */
  readonly heal?: HealConnection
}

interface PendingRequest {
  url: string
  at: number
}

interface UplinkNote {
  endpoint: string
  detail: string
  at: number
}

interface DownlinkNote {
  endpoint: string
  detail: string
  bytes: number
  at: number
}

interface WatchdogState {
  /** Last frame the multiplexer delivered, used to tell a stall from a busy page. */
  lastDownlinkAt: number
  uplink: number
  downlink: number
  downlinkBytes: number
  opened: number
  closed: number
  failed: number
  lastClose: string
  followOpens: number
  followAt: number
  uplinks: UplinkNote[]
  downlinks: DownlinkNote[]
  endpoints: Map<string, string>
  sockets: Set<WebSocket>
  muxSockets: Set<WebSocket>
  pending: Map<string, PendingRequest>
  heals: number
  lastHealUsedDsh: boolean
  reloads: number
  reloaded: boolean
}

/** A multiplexer `open` frame, reduced to the parts worth putting on screen. */
export interface OpenFrameNote {
  streamId: string
  endpoint: string
  detail: string
}

/** A multiplexer downlink frame, reduced to the parts worth putting on screen. */
export interface DownlinkFrameNote {
  streamId: string
  kind: string
  detail: string
  bytes: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function shortSessionId(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '?'
  const tail = value.startsWith('session-') ? value.slice('session-'.length) : value
  return `session-${tail.slice(0, 8)}`
}

function describeAddress(address: unknown): string {
  const record = asRecord(address)
  if (record === null) return '?'
  if (record.kind === 'subagent') return `${shortSessionId(record.parentSessionId)}/${shortSessionId(record.childSessionId)}`
  return shortSessionId(record.sessionId)
}

function describeWindow(request: Record<string, unknown>): string {
  const max = typeof request.maxMessages === 'number' ? String(request.maxMessages) : '-'
  const turnWindow = asRecord(request.turnWindow)
  const turn = turnWindow === null
    ? '-'
    : `${String(turnWindow.minMessages ?? '?')}/${String(turnWindow.minTurns ?? '?')}`
  const assistant = request.assistantStream === true ? 'y' : '-'
  return `max=${max} turn=${turn} as=${assistant}`
}

/**
 * Reduce one uplinked `open` frame to its endpoint, stream and request knobs.
 *
 * The wire shape is the gateway's, not the transport's: the method request sits
 * at `payload.args.request`, which is why the session-window shim can rewrite
 * the same path before the frame leaves the page.
 */
export function describeOpenFrame(data: unknown): OpenFrameNote | null {
  if (typeof data !== 'string' || data.indexOf('"endpoint"') < 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  const frame = asRecord(parsed)
  if (frame === null || frame.type !== 'open') return null
  const endpoint = typeof frame.endpoint === 'string' ? frame.endpoint : ''
  const streamId = typeof frame.streamId === 'string' ? frame.streamId : ''
  if (endpoint === '' || streamId === '') return null
  const payload = asRecord(frame.payload)
  const args = asRecord(payload?.args)
  const request = asRecord(args?.request)
  const detail = request === null
    ? ''
    : `[${describeAddress(request.address)} ${describeWindow(request)}]`
  return { streamId, endpoint, detail }
}

/** Reduce one downlinked frame to its kind, stream pairing and byte size. */
export function describeDownlinkFrame(data: unknown): DownlinkFrameNote | null {
  if (typeof data !== 'string' || data.length === 0 || data.charAt(0) !== '{') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  const frame = asRecord(parsed)
  if (frame === null) return null
  const kind = typeof frame.type === 'string' ? frame.type : ''
  const streamId = typeof frame.streamId === 'string' ? frame.streamId : ''
  if (streamId === '') return null
  const bytes = data.length
  if (kind === 'item') {
    const item = asRecord(frame.value)
    const itemType = typeof item?.type === 'string' ? item.type : 'item'
    const records = Array.isArray(item?.records) ? ` rec=${String(item.records.length)}` : ''
    return { streamId, kind: itemType, detail: records, bytes }
  }
  if (kind === 'error') {
    const error = asRecord(frame.error)
    const code = typeof error?.code === 'string' ? error.code : 'error'
    const message = typeof error?.message === 'string' ? ` ${error.message.slice(0, 60)}` : ''
    return { streamId, kind: 'error', detail: ` ${code}${message}`, bytes }
  }
  if (kind === 'end') return { streamId, kind: 'end', detail: '', bytes }
  return null
}

/** Bytes as a compact size for the diagnostic sheet. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url, location.href)
    if (parsed.origin === location.origin) return parsed.pathname + parsed.search.slice(0, 60)
    return parsed.origin + parsed.pathname
  } catch {
    return url.slice(0, 90)
  }
}

function sessionHint(): string {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key === null) continue
      if (key.toLowerCase().indexOf('session') < 0 && key.toLowerCase().indexOf('chat') < 0) continue
      const value = localStorage.getItem(key) ?? ''
      if (value.indexOf('session-') >= 0) return `${key}=${value.slice(0, 120)}`
    }
  } catch {
    /* private mode: keep the sheet useful anyway */
  }
  return '(未找到会话缓存)'
}

/**
 * Text of the chat view's own status node, or `''` when it is not rendered.
 *
 * Only direct children of `[data-chat-flow]` are considered: DSH renders the
 * history hint and the open error as siblings of the transcript, so a quoted
 * 「载入历史」 inside a message is never mistaken for the status node.
 */
export function chatStatusText(flow: Element | null, suffixes: readonly string[]): string {
  if (flow === null) return ''
  for (const child of flow.children) {
    const className = typeof child.className === 'string' ? child.className : ''
    if (!suffixes.some(suffix => className.split(/\s+/u).some(token => token.endsWith(suffix)))) continue
    return (child.textContent ?? '').trim().slice(0, 200)
  }
  return ''
}

/** What the watchdog knows about a possible stuck history load. */
export interface HistoryStall {
  /** The page is on screen; a backgrounded phone must not be reloaded. */
  readonly visible: boolean
  /** Text of the chat view's hint node, `''` when the view is not loading. */
  readonly hint: string
  /** Milliseconds since the last multiplexer frame arrived. */
  readonly idleMs: number
}

/** Whether the hint is up *and* the multiplexer has gone quiet. */
export function isHistoryStalled(stall: HistoryStall): boolean {
  return stall.visible && stall.hint !== '' && stall.idleMs >= IDLE_AFTER_MS
}

/** Install the watchdog; returns a disposer that restores every patched API. */
export function installPhoneWatchdog(options: PhoneWatchdogOptions = {}): () => void {
  const heal = options.heal
  const state: WatchdogState = {
    lastDownlinkAt: Date.now(),
    uplink: 0,
    downlink: 0,
    downlinkBytes: 0,
    opened: 0,
    closed: 0,
    failed: 0,
    lastClose: '—',
    followOpens: 0,
    followAt: 0,
    uplinks: [],
    downlinks: [],
    endpoints: new Map<string, string>(),
    sockets: new Set<WebSocket>(),
    muxSockets: new Set<WebSocket>(),
    pending: new Map<string, PendingRequest>(),
    heals: 0,
    lastHealUsedDsh: false,
    reloads: 0,
    reloaded: false,
  }

  const socketSend = WebSocket.prototype.send
  WebSocket.prototype.send = function send(data: unknown): void {
    state.uplink += 1
    const note = describeOpenFrame(data)
    if (note !== null) {
      state.endpoints.set(note.streamId, note.endpoint)
      state.uplinks.push({ endpoint: note.endpoint, detail: note.detail, at: Date.now() })
      if (state.uplinks.length > MAX_FRAME_NOTES) state.uplinks.shift()
      if (note.endpoint === 'session/follow') {
        state.followOpens += 1
        state.followAt = Date.now()
      }
    }
    return socketSend.call(this, data as string)
  }

  const socketAddEventListener = WebSocket.prototype.addEventListener
  WebSocket.prototype.addEventListener = function addEventListener(
    this: WebSocket,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener !== null && (type === 'message' || type === 'open' || type === 'close' || type === 'error')) {
      state.sockets.add(this)
      const wrapped = (event: Event): void => {
        if (type === 'message') {
          state.downlink += 1
          state.lastDownlinkAt = Date.now()
          const data = (event as MessageEvent).data
          if (typeof data === 'string') state.downlinkBytes += data.length
          const note = describeDownlinkFrame(data)
          if (note !== null) {
            state.downlinks.push({
              endpoint: state.endpoints.get(note.streamId) ?? '?',
              detail: `${note.kind}${note.detail}`,
              bytes: note.bytes,
              at: Date.now(),
            })
            if (state.downlinks.length > MAX_FRAME_NOTES) state.downlinks.shift()
          }
        } else if (type === 'open') {
          state.opened += 1
          try {
            if (this.url.indexOf(MUX_URL_MARKER) >= 0) state.muxSockets.add(this)
          } catch {
            /* a mocked socket without a url: no mux bookkeeping */
          }
        } else if (type === 'error') state.failed += 1
        else {
          state.closed += 1
          const close = event as CloseEvent
          state.lastClose = `${String(close.code ?? '?')} ${String(close.reason ?? '')}`.trim()
          state.sockets.delete(this)
          state.muxSockets.delete(this)
        }
        if (typeof listener === 'function') listener.call(this, event)
        else listener.handleEvent(event)
      }
      return socketAddEventListener.call(this, type, wrapped as EventListener, options)
    }
    return socketAddEventListener.call(this, type, listener as EventListener, options)
  }

  const nativeFetch = window.fetch
  let fetchPatched = false
  if (typeof nativeFetch === 'function') {
    fetchPatched = true
    window.fetch = function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const note: PendingRequest = { url: shortUrl(url), at: Date.now() }
      const key = `${String(note.at)}:${note.url}:${String(Math.random())}`
      state.pending.set(key, note)
      const done = (): void => { state.pending.delete(key) }
      const promise = nativeFetch.call(this, input as RequestInfo, init)
      promise.then(done, done)
      return promise
    }
  }

  let sheet: HTMLDivElement | null = null
  let sheetBody: HTMLPreElement | null = null
  let loadingSince = 0
  let nextHealAt = 0
  let healGap = HEAL_AFTER_MS
  let reloadAt = 0
  let lastError = ''
  let hiddenAt = document.visibilityState === 'visible' ? 0 : Date.now()

  const report = (): string => {
    const now = Date.now()
    const lines: string[] = []
    lines.push(`时间 ${new Date(now).toLocaleTimeString()} · 页面 ${location.host}`)
    lines.push(`可见性 ${document.visibilityState} · 网络 ${navigator.onLine ? 'online' : 'offline'}`)
    lines.push(`等待「${HISTORY_LOADING_TEXT}」已 ${loadingSince === 0 ? 0 : Math.round((now - loadingSince) / 1000)} 秒 · 无下行帧 ${Math.round((now - state.lastDownlinkAt) / 1000)} 秒`)
    if (lastError !== '') lines.push(`页面报错：${lastError}`)
    lines.push(`长连接 open ${state.opened} / close ${state.closed} / error ${state.failed} · 最后关闭 ${state.lastClose}`)
    lines.push(`帧 上行 ${state.uplink} / 下行 ${state.downlink}（${formatBytes(state.downlinkBytes)}）· session/follow ${state.followOpens} 次${state.followAt === 0 ? '' : `（最后 ${Math.round((now - state.followAt) / 1000)} 秒前）`}`)
    const uplinks = state.uplinks.slice(-MAX_NOTES_SHOWN).map(note => `${note.endpoint}${note.detail}@${Math.round((now - note.at) / 1000)}s`)
    if (uplinks.length > 0) lines.push(`最近上行：${uplinks.join(' ')}`)
    const downlinks = state.downlinks.slice(-MAX_NOTES_SHOWN).map(note => `${note.detail} ${formatBytes(note.bytes)} ←${note.endpoint} @${Math.round((now - note.at) / 1000)}s`)
    if (downlinks.length > 0) lines.push(`最近下行：${downlinks.join(' · ')}`)
    lines.push(`进行中请求 ${state.pending.size}`)
    const slow = [...state.pending.values()].sort((left, right) => left.at - right.at).slice(0, MAX_PENDING_SHOWN)
    for (const request of slow) lines.push(`  ${Math.round((now - request.at) / 1000)}s ${request.url}`)
    lines.push(`自愈：DSH 重连 ${state.heals} 次${state.heals === 0 ? '' : state.lastHealUsedDsh ? '（已调用）' : '（无句柄，已强断）'} · 刷新 ${state.reloads} 次`)
    lines.push(`会话缓存 ${sessionHint()}`)
    return lines.join('\n')
  }

  const closeSockets = (): void => {
    for (const socket of state.sockets) {
      try {
        socket.close(4001, 'phone watchdog reconnect')
      } catch {
        /* already gone */
      }
    }
    state.sockets.clear()
    state.muxSockets.clear()
  }

  /** Rebuild the gateway connection the supported way, falling back to a hard close. */
  const healNow = (): void => {
    state.heals += 1
    let usedDsh = false
    if (heal !== undefined) {
      try {
        usedDsh = heal()
      } catch {
        usedDsh = false
      }
    }
    state.lastHealUsedDsh = usedDsh
    // Without a reachable Connection handle a closed socket is never replaced
    // (the mux owns no retry schedule), so the reload below is the only cure.
    if (!usedDsh) closeSockets()
    state.lastDownlinkAt = Date.now()
  }

  const reloadNow = (guard: boolean): void => {
    if (guard) {
      let last = 0
      try {
        last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? '0')
      } catch {
        last = 0
      }
      if (Number.isFinite(last) && Date.now() - last < RELOAD_GUARD_MS) return
    }
    try {
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
    } catch {
      /* ignore */
    }
    state.reloads += 1
    state.reloaded = true
    location.reload()
  }

  const sheetButton = (label: string, background: string, colour: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.setAttribute('style', `margin:10px 8px 0 0;padding:8px 14px;border:0;border-radius:9px;background:${background};color:${colour};font:650 13px/1 system-ui`)
    button.addEventListener('click', onClick)
    return button
  }

  const showSheet = (text: string): void => {
    if (sheet === null) {
      sheet = document.createElement('div')
      sheet.dataset.plugin = 'dsh-mobile-watchdog'
      sheet.setAttribute('style', [
        'position:fixed', 'z-index:2147483000', 'left:8px', 'right:8px', 'bottom:8px',
        'max-height:62vh', 'overflow:auto', 'padding:12px 14px', 'border-radius:14px',
        'background:rgba(15,23,42,.94)', 'color:#f8fafc', 'font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace',
        'box-shadow:0 18px 44px rgba(15,23,42,.45)', 'white-space:pre-wrap', 'word-break:break-all',
      ].join(';'))
      sheetBody = document.createElement('pre')
      sheetBody.setAttribute('style', 'margin:0;white-space:pre-wrap;word-break:break-all')
      const actions = document.createElement('div')
      actions.append(
        sheetButton('重新连接', '#38bdf8', '#082f49', () => {
          healNow()
          showSheet(report())
        }),
        sheetButton('立即重新加载', '#fbbf24', '#451a03', () => { reloadNow(false) }),
        sheetButton('关闭', '#475569', '#f8fafc', () => { if (sheet !== null) sheet.hidden = true }),
      )
      sheet.append(sheetBody, actions)
      document.body.append(sheet)
    }
    sheet.hidden = false
    if (sheetBody !== null) sheetBody.textContent = text
  }

  const timer = window.setInterval(() => {
    const now = Date.now()
    const flow = document.querySelector('[data-chat-flow]')
    const error = chatStatusText(flow, HISTORY_ERROR_SUFFIXES)
    if (error !== '') lastError = error
    const hint = chatStatusText(flow, HISTORY_HINT_SUFFIXES)
    const stalled = isHistoryStalled({
      visible: document.visibilityState === 'visible',
      hint,
      idleMs: now - state.lastDownlinkAt,
    })
    if (!stalled) {
      loadingSince = 0
      nextHealAt = 0
      healGap = HEAL_AFTER_MS
      reloadAt = 0
      // Recovered on its own: take the sheet away instead of leaving it on screen.
      if (sheet !== null) sheet.hidden = true
      return
    }
    if (loadingSince === 0) {
      loadingSince = now
      nextHealAt = now + HEAL_AFTER_MS
      healGap = HEAL_AFTER_MS
      reloadAt = 0
      return
    }
    const waited = now - loadingSince
    if (waited >= SHEET_AFTER_MS) showSheet(report())
    if (now >= nextHealAt) {
      healNow()
      healGap = Math.min(HEAL_MAX_GAP_MS, healGap * HEAL_GROWTH)
      nextHealAt = Date.now() + healGap
      showSheet(report())
    }
    if (waited >= RELOAD_AFTER_MS && reloadAt === 0) {
      reloadAt = now
      reloadNow(true)
    }
  }, POLL_MS)

  /** A restored or long-hidden page almost always holds a dead multiplexer. */
  const healOnResume = (reason: string): void => {
    if (typeof heal !== 'function') return
    let muxDown = state.muxSockets.size > 0
    for (const socket of state.muxSockets) if (socket.readyState === WebSocket.OPEN) muxDown = false
    if (!muxDown && Date.now() - state.lastDownlinkAt < RESUME_HIDE_MS) return
    healNow()
    if (sheet !== null) sheet.hidden = false
    void reason
  }

  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      return
    }
    const hidden = hiddenAt === 0 ? 0 : Date.now() - hiddenAt
    hiddenAt = 0
    if (hidden >= RESUME_HIDE_MS) healOnResume('visible')
  }
  const onOnline = (): void => healOnResume('online')
  const onPageShow = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted === true) healOnResume('pageshow')
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)
  window.addEventListener('pageshow', onPageShow)

  if (typeof window !== 'undefined') {
    Object.defineProperty(window as unknown as Record<string, unknown>, '__DSH_MOBILE_WATCHDOG__', {
      value: report,
      configurable: true,
    })
  }

  return () => {
    window.clearInterval(timer)
    WebSocket.prototype.send = socketSend
    WebSocket.prototype.addEventListener = socketAddEventListener
    if (fetchPatched) window.fetch = nativeFetch
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('pageshow', onPageShow)
    if (sheet !== null) sheet.remove()
    sheet = null
    sheetBody = null
    state.sockets.clear()
    state.muxSockets.clear()
    state.pending.clear()
  }
}
