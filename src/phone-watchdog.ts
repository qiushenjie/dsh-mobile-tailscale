/**
 * Phone-side session watchdog.
 *
 * The remote channel is a long-lived WebSocket multiplexer. When the phone's
 * connection dies mid-handshake (Tailscale suspended, radio handover, a carrier
 * that never reconnects) the chat view keeps its "loading history" hint up
 * forever: the request is neither answered nor rejected, so DSH never renders
 * the error path. This module runs inside the phone page (client bundle, so a
 * page refresh is enough to deploy it) and:
 *
 * 1. records what the page is actually waiting for (mux frames, socket state,
 *    in-flight requests) while the history hint is on screen;
 * 2. after a short stall closes the mux socket so the gateway client's own
 *    reconnect path runs -- the same recovery that unblocks a half-dead socket;
 * 3. if that does not help, reloads the page once per session window and shows
 *    a compact diagnostic sheet the user can screenshot.
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
const IDLE_AFTER_MS = 8_000
const SHEET_AFTER_MS = 12_000
const RECONNECT_AFTER_MS = 20_000
const RELOAD_AFTER_MS = 40_000
const RELOAD_GUARD_KEY = 'dsh-mobile-watchdog-reloaded'
const RELOAD_GUARD_MS = 180_000
const MAX_PENDING_SHOWN = 6

interface FrameNote {
  endpoint: string
  at: number
}

interface PendingRequest {
  url: string
  at: number
}

interface WatchdogState {
  /** Last frame the multiplexer delivered, used to tell a stall from a busy page. */
  lastDownlinkAt: number
  uplink: number
  downlink: number
  opened: number
  closed: number
  failed: number
  lastClose: string
  followOpens: number
  followAt: number
  frames: FrameNote[]
  sockets: Set<WebSocket>
  pending: Map<string, PendingRequest>
  reconnects: number
  reloaded: boolean
}

function endpointOf(data: unknown): string | null {
  if (typeof data !== 'string' || data.indexOf('"endpoint"') < 0) return null
  try {
    const frame = JSON.parse(data) as { endpoint?: unknown }
    if (typeof frame !== 'object' || frame === null) return null
    return typeof frame.endpoint === 'string' && frame.endpoint !== '' ? frame.endpoint : null
  } catch {
    return null
  }
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
export function installPhoneWatchdog(): () => void {
  const state: WatchdogState = {
    lastDownlinkAt: Date.now(),
    uplink: 0,
    downlink: 0,
    opened: 0,
    closed: 0,
    failed: 0,
    lastClose: '—',
    followOpens: 0,
    followAt: 0,
    frames: [],
    sockets: new Set<WebSocket>(),
    pending: new Map<string, PendingRequest>(),
    reconnects: 0,
    reloaded: false,
  }

  const socketSend = WebSocket.prototype.send
  WebSocket.prototype.send = function send(data: unknown): void {
    state.uplink += 1
    const endpoint = endpointOf(data)
    if (endpoint !== null) {
      state.frames.push({ endpoint, at: Date.now() })
      if (state.frames.length > 12) state.frames.shift()
      if (endpoint === 'session/follow') {
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
        } else if (type === 'open') state.opened += 1
        else if (type === 'error') state.failed += 1
        else {
          state.closed += 1
          const close = event as CloseEvent
          state.lastClose = `${String(close.code ?? '?')} ${String(close.reason ?? '')}`.trim()
          state.sockets.delete(this)
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
  let reconnectAt = 0
  let reloadAt = 0
  let lastError = ''

  const report = (): string => {
    const now = Date.now()
    const lines: string[] = []
    lines.push(`时间 ${new Date(now).toLocaleTimeString()} · 页面 ${location.host}`)
    lines.push(`可见性 ${document.visibilityState} · 网络 ${navigator.onLine ? 'online' : 'offline'}`)
    lines.push(`等待「${HISTORY_LOADING_TEXT}」已 ${loadingSince === 0 ? 0 : Math.round((now - loadingSince) / 1000)} 秒 · 无下行帧 ${Math.round((now - state.lastDownlinkAt) / 1000)} 秒`)
    if (lastError !== '') lines.push(`页面报错：${lastError}`)
    lines.push(`长连接 open ${state.opened} / close ${state.closed} / error ${state.failed} · 最后关闭 ${state.lastClose}`)
    lines.push(`帧 上行 ${state.uplink} / 下行 ${state.downlink} · session/follow ${state.followOpens} 次${state.followAt === 0 ? '' : `（最后 ${Math.round((now - state.followAt) / 1000)} 秒前）`}`)
    const recent = state.frames.slice(-4).map((frame) => `${frame.endpoint}@${Math.round((now - frame.at) / 1000)}s`)
    if (recent.length > 0) lines.push(`最近上行：${recent.join(' ')}`)
    const slow = [...state.pending.values()].sort((left, right) => left.at - right.at).slice(0, MAX_PENDING_SHOWN)
    lines.push(`进行中请求 ${state.pending.size}`)
    for (const request of slow) lines.push(`  ${Math.round((now - request.at) / 1000)}s ${request.url}`)
    lines.push(`自愈：重连 ${state.reconnects} 次${state.reloaded ? ' · 已自动刷新' : ''}`)
    lines.push(`会话缓存 ${sessionHint()}`)
    return lines.join('\n')
  }

  const closeSockets = (): void => {
    state.reconnects += 1
    for (const socket of state.sockets) {
      try {
        socket.close(4001, 'phone watchdog reconnect')
      } catch {
        /* already gone */
      }
    }
    state.sockets.clear()
  }

  const reloadOnce = (): void => {
    let last = 0
    try {
      last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? '0')
    } catch {
      last = 0
    }
    if (Number.isFinite(last) && Date.now() - last < RELOAD_GUARD_MS) return
    try {
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
    } catch {
      /* ignore */
    }
    state.reloaded = true
    location.reload()
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
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '关闭'
      close.setAttribute('style', 'margin-top:10px;padding:8px 14px;border:0;border-radius:9px;background:#38bdf8;color:#082f49;font:650 13px/1 system-ui')
      close.addEventListener('click', () => { if (sheet !== null) sheet.hidden = true })
      sheet.append(sheetBody, close)
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
      reconnectAt = 0
      reloadAt = 0
      // Recovered on its own: take the sheet away instead of leaving it on screen.
      if (sheet !== null) sheet.hidden = true
      return
    }
    if (loadingSince === 0) {
      loadingSince = now
      reconnectAt = 0
      reloadAt = 0
      return
    }
    const waited = now - loadingSince
    if (waited >= SHEET_AFTER_MS) showSheet(report())
    if (waited >= RECONNECT_AFTER_MS && reconnectAt === 0) {
      reconnectAt = now
      closeSockets()
      showSheet(report())
    }
    if (waited >= RELOAD_AFTER_MS && reloadAt === 0) {
      reloadAt = now
      reloadOnce()
    }
  }, POLL_MS)

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
    if (sheet !== null) sheet.remove()
    sheet = null
    sheetBody = null
    state.sockets.clear()
    state.pending.clear()
  }
}
