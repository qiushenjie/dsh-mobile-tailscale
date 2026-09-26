import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { extname } from 'node:path'
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  AUTH_PREFIX,
  cookie,
  HttpError,
  parseRequestTarget,
  readJsonObject,
  sendFailure,
  sendJson,
  setSecurityHeaders,
} from './http-security.js'
import {
  DSH_MOBILE_MODULE_ID,
  DSH_MOBILE_VERSION,
  MOBILE_METADATA_VERSION,
} from './version.js'
import {
  MobileExtensionError,
  type MobileAccessService,
  type MobileRouteRequest,
  type MobileRouteResponse,
} from './extensions.js'




const MOBILE_HISTORY_PAGE_MESSAGES = 10
const SESSION_HISTORY_PATH = '/api/session.history'
/**
 * Messages a phone may ask for when it opens a session.
 *
 * DSH's own client page size is 50 (`PAGE_MESSAGES` in
 * `@deepseek-ai/dsh-api-session-controller`), and its ordinary window asks for
 * 500. Everything the phone opens — the session it restores on a page load and
 * every row it taps — arrives through that window, so this is the one number
 * that decides how heavy a conversation is on a phone.
 */
const MOBILE_SESSION_WINDOW_MESSAGES = 10
/**
 * Every request target whose body carries a session history window.
 *
 * DSH 0.1.7 streams a session's opening window over the WebSocket mux
 * (`session/follow`) and pages older messages through `session/page`; the
 * `/api/session.history` spelling predates both and is kept for older clients
 * that still post the window directly.
 */
const SESSION_WINDOW_PATHS: readonly string[] = Object.freeze([
  SESSION_HISTORY_PATH,
  '/api/session.page',
  '/api/session.follow',
])
const MOBILE_LAYOUT_MODULE = '@deepseek-ai/dsh-client-ui-layout'
const MOBILE_LAYOUT_PATH = `${AUTH_PREFIX}/mobile-layout.js`
export const MOBILE_LAYOUT_NEXT_PATH = `${AUTH_PREFIX}/mobile-layout-next.js`
const MOBILE_BOOT_BATCH_PREFIX = `${AUTH_PREFIX}/mobile-boot/`
const MAX_MOBILE_BOOT_BATCH_BYTES = 32 * 1024 * 1024
const MAX_MOBILE_BOOT_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_MOBILE_BOOT_BATCHES = 8
const CUSTOM_STYLE_FALLBACK = '/* Add mobile overrides in the DSH home mobile-access/mobile.css file. */\n'
const CUSTOM_SCRIPT_FALLBACK = 'window.dshMobile?.register(() => undefined)\n'
const MOBILE_CLIENT_MODULE = DSH_MOBILE_MODULE_ID
const CONNECTION_MODULE = '@deepseek-ai/dsh-client-connection'
const RUNTIME_MODULE = '@deepseek-ai/dsh-client-runtime'
const RENDERER_MODULE = '@deepseek-ai/dsh-client-ui-renderer'
const SIDEBAR_MODULE = '@deepseek-ai/dsh-client-ui-sidebar'
const SETTINGS_MODULE = '@deepseek-ai/dsh-client-ui-settings'
const API_GATEWAY_MODULE = '@deepseek-ai/dsh-api-gateway'
const MOBILE_LAYOUT_DEPENDENCY_PROFILES = Object.freeze([
  Object.freeze({
    slots: RUNTIME_MODULE,
    dependencies: Object.freeze([RUNTIME_MODULE, '@deepseek-ai/dsh-client-ui-theme']),
  }),
  Object.freeze({
    slots: RENDERER_MODULE,
    dependencies: Object.freeze([
      '@deepseek-ai/dsh-client-locale',
      RENDERER_MODULE,
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-theme',
    ]),
  }),
])

/**
 * Client modules that exist only for the desktop shell, and must not activate on
 * a phone page.
 *
 * DSH Desktop NEXT supplies `dsh-desktop-next` (1.1 MB raw, 628 KB gzipped) to
 * every client graph, where it draws the shell's own chrome: desktop settings
 * pages, the remote-control surface, native window materials. None of that
 * applies on a phone, and it is not merely dead weight — it installs two
 * `MutationObserver`s on `document.body` with `subtree: true`, one of which runs
 * its handler for every mutation batch without coalescing. Measured on the phone
 * channel that is a direct competitor for the main thread against everything
 * else the page does.
 *
 * Dropping the entry stops it from being activated, so none of its code runs.
 * On a manifest that ships combined batches the module's bytes go away with it
 * (see {@link pruneUnavailableClientModules}), because the plugin serves those
 * batches itself; on the generation that fetched every module separately the
 * bytes are still downloaded but never executed. It is safe to drop: no other
 * entry declares it as a dependency, so removing it cannot displace anything
 * else in the graph.
 */
const DESKTOP_SHELL_ONLY_MODULES: readonly string[] = Object.freeze(['dsh-desktop-next'])

/**
 * Third-party client modules that cannot work on a DSH 0.1.7 page at all.
 *
 * Measured on this machine, live:
 *
 * - `dsh-better-sidebar` renders the right sidebar's panes. Its client calls
 *   `require("@deepseek-ai/dsh-client-ui-primitives")`, a module DSH 0.1.7 no
 *   longer puts in the client graph (the served manifest carries 71 entries and
 *   none of them is it), so the import resolves to `undefined` and every pane it
 *   renders dies with `Minified React error #130` — the phone's 文件 pane shows
 *   only its 重试 button, which fails again on every retry. Its host half also
 *   fails to activate (`sctx.settings.register is not a function`).
 * - `dsh-rewind-plugin` reads `snapshot.queue` from a session snapshot that
 *   0.1.7 no longer sends, and throws `TypeError: Cannot read properties of
 *   undefined (reading 'filter')` from `collectPendingTargets` inside
 *   `conversation.session.header.actions`, crashing that slot on every render.
 *
 * Neither is injected by another entry (checked against the served manifest), so
 * dropping them costs the phone only UI that already fails to render there and
 * returns the stock sidebar and message actions; the desktop keeps both.
 */
const MOBILE_BROKEN_ON_DSH_017_MODULES: readonly string[] = Object.freeze([
  'dsh-better-sidebar',
  'dsh-rewind-plugin',
])

/**
 * Client modules pruned from the served boot graph even though the phone would
 * otherwise activate them, because their download cost dwarfs their value on a
 * phone.
 *
 * `@deepseek-ai/dsh-client-ui-settings-account` bundles the DeepSeek login and
 * Platform billing pages and measured 5,281,067 bytes raw / ~3.7 MB gzip — 65%
 * of the whole phone boot payload (5.8 MB gzip) on DSH 0.1.7. Nothing injects it
 * (searching its id across the app and profile `node_modules` only finds its own
 * manifest), so pruning it removes that single settings page and leaves every
 * other page, the layout and the conversation untouched.
 *
 * Only list a module here after proving nothing injects it: an entry some other
 * entry requires cannot be dropped without breaking its consumer.
 */
const MOBILE_BOOT_EXCLUDED_MODULES: readonly string[] = Object.freeze([
  '@deepseek-ai/dsh-client-ui-settings-account',
  ...MOBILE_BROKEN_ON_DSH_017_MODULES,
])


/**
 * A module injected by the layout generation that replaced the root's
 * `conversation`/`details` children with `main` (keyed), `rightbar` and
 * `shell.leading`, and which the previous generation did not inject.
 *
 * The boot manifest exposes no slot declarations, so the layout module's own
 * dependency list is the only generation marker reachable from here.
 */
const LAYOUT_GENERATION_MARKER = '@deepseek-ai/dsh-client-shortcuts'


/**
 * Declare this page as the owner of its own transport, before ANY boot module
 * runs.
 *
 * `@deepseek-ai/dsh-client-connection` builds its handle with
 * `isLoopback: transport?.ownsHost === true || <loopback hostname>`. A phone
 * page is never on a loopback hostname, so without this the handle is born
 * `isLoopback: false`.
 *
 * Mutating `connection.isLoopback` later from the mobile client module is NOT
 * equivalent, because `@deepseek-ai/dsh-api-gateway` memoizes the value:
 *
 * ```js
 * get $host() {
 *   const home = this.connection.generation.getSnapshot()?.host.home
 *   if (this.hostFacts === void 0 || this.hostFacts.home !== home) this.hostFacts = {
 *     home, isLoopback: this.connection.isLoopback,
 *   }
 *   return this.hostFacts
 * }
 * ```
 *
 * The cache is keyed on `home` alone. On the remote channel `home` is stable,
 * so the first consumer of `ctx.remote.$host` freezes `isLoopback: false` for
 * the life of the page — and `dsh-client-ui-settings`,
 * `dsh-client-ui-settings-general`, `dsh-api-session-controller` and
 * `dsh-client-ui-workspace` all read the cached `ctx.remote.$host`. That is why
 * the trust must exist before the boot manifest is evaluated, not after a
 * module activates.
 *
 * Deviation from upstream: upstream throws when `__DSH_TRANSPORT__` already
 * exists. This statement shares a script block with the boot manifest
 * assignment, so throwing would blank the whole mobile page — the failure mode
 * this plugin has already been burned by. An existing override is therefore
 * left untouched, and the client-side trust hint remains as the fallback.
 */
const MOBILE_AUTHENTICATED_TRANSPORT_BOOTSTRAP = `(()=>{if(window.__DSH_TRANSPORT__!==undefined)return;window.__DSH_TRANSPORT__={fetch:(input,init)=>window.fetch(input,init),ownsHost:true}})();`

/**
 * Cap the session window a phone asks for, at the frame that asks for it.
 *
 * DSH 0.1.7 does not fetch a session's history over HTTP: every Gateway stream,
 * `session/follow` included, travels the WebSocket mux at `/api/remote.mux` as
 * a text frame. Measured on this machine's phone path, a page load and every
 * session tap sent
 *
 * ```json
 * {"type":"open","endpoint":"session/follow","payload":{"args":{"request":
 *   {"address":{…},"assistantStream":true,"maxMessages":500,
 *    "turnWindow":{"minMessages":50,"minTurns":2}}}}}
 * ```
 *
 * `maxMessages: 500` is the desktop client's ordinary window, so a phone opening
 * a long conversation pulled hundreds of records and then had to render them:
 * opening such a session was slow and every later interaction in it stayed slow,
 * while the same page with a short session stayed responsive. The plugin's own
 * HTTP trim never saw this request — it matches `/api/session.history`, which no
 * DSH 0.1.7 client calls.
 *
 * The Turn floor is dropped with it, and that is the part that actually bounded
 * the page. `paginate` walks the log backwards and cuts at whichever comes first
 * — the message count reaching `maxMessages`, or a `turn/start` once
 * `count >= minMessages` and the Turn count reaches `minTurns` — so
 * `{"minMessages":50,"minTurns":2}` keeps pulling whole Turns and can hand back
 * six records per message. Measured over the tailnet on an idle 291-record
 * session: `maxMessages:500` + the Turn floor delivered 797 KB of snapshot and
 * 291 records, 1588 ms of main-thread work and a 650 ms frame gap at 6x CPU;
 * `maxMessages:10` with the floor dropped delivered 190 KB, 60 records, 1178 ms
 * and a 383 ms gap, with `hasMore: true` so 加载更早 still pages backwards.
 *
 * Clamping the frame instead of the transport keeps the cap independent of how
 * the window is spelled: the mux carries JSON, every other frame is forwarded
 * untouched, and a request already at or below the cap keeps its message count.
 */
const MOBILE_SESSION_WINDOW_BOOTSTRAP = `(()=>{const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){if(typeof data==="string"&&data.includes('"endpoint":"session/follow"')){try{const frame=JSON.parse(data);const request=frame&&frame.payload&&frame.payload.args&&frame.payload.args.request;if(request&&typeof request==="object"){if(typeof request.maxMessages!=="number"||request.maxMessages>${MOBILE_SESSION_WINDOW_MESSAGES})request.maxMessages=${MOBILE_SESSION_WINDOW_MESSAGES};delete request.turnWindow;data=JSON.stringify(frame)}}catch(error){}}return send.call(this,data)}})();`


interface BootGraphEntry {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: boolean
}

interface BootGraphBatch {
  phase: 'bootstrap' | 'application'
  url: string
  rev: string
  entries: string[]
}

/** One client module inside a plugin-served boot batch. */
export interface MobileBootBatchEntry {
  readonly id: string
  readonly url: string
  readonly rev: string
}

/**
 * One boot batch this plugin serves itself, at
 * `/mobile-access/mobile-boot/<key>.js`, instead of letting the phone download
 * the upstream combined request unchanged.
 */
export interface MobileBootBatchPlan {
  /** Revision key of the plan; reused as the rewritten batch's manifest `rev`. */
  readonly key: string
  /** Path the phone requests for this batch. */
  readonly path: string
  /**
   * The upstream combined request this plan replaced. Serving it unchanged is
   * the fallback when assembling the pruned batch fails, so pruning can never
   * cost the phone its boot payload.
   */
  readonly upstream: { readonly url: string; readonly rev: string }
  readonly entries: readonly MobileBootBatchEntry[]
}

/**
 * Which layout a phone page gets. `auto` replaces only the layout generations
 * this plugin implements, `mobile` also replaces the current one, and `stock`
 * never replaces the upstream layout.
 */
export type MobileLayoutMode = 'auto' | 'mobile' | 'stock'

/** Result of a rewritten index: the document plus the batches it now points at. */
export interface RewrittenMobileIndex {
  readonly html: string
  readonly batches?: readonly MobileBootBatchPlan[]
}

interface StoredMobileBootBatch {
  readonly plan: MobileBootBatchPlan
  body?: Buffer
  gzipBody?: Buffer
  etag?: string
  fingerprint?: string
}

const gzipBuffer = promisify(gzip)

/**
 * Assemble and cache the combined boot batches a rewritten manifest points at.
 *
 * DSH asks for the whole graph in one request per phase (`plugins/??id/client.js,…`)
 * and the upstream server only answers the exact combinations it built, so a
 * batch that drops a module has to be assembled here instead. Both faces of the
 * plugin keep their own store — the LAN gateway and the remote passthrough proxy
 * reach upstream with different credentials and either may be the only one
 * enabled.
 */
export class MobileBootBatchStore {
  private readonly batches = new Map<string, StoredMobileBootBatch>()
  private readonly loadEntry: (entry: MobileBootBatchEntry, signal: AbortSignal) => Promise<Buffer>
  private readonly fingerprint: () => Promise<string>
  private readonly maxBatches: number
  private readonly loadFallback: ((plan: MobileBootBatchPlan, signal: AbortSignal) => Promise<Buffer>) | undefined

  /**
   * @param loadEntry - Fetches one module's client bundle.
   * @param fingerprint - Changes whenever the stored bodies must be rebuilt.
   * @param maxBatches - How many plans to keep before evicting the oldest.
   * @param loadFallback - Serves the upstream's own combined request when a module cannot be fetched.
   */
  constructor(
    loadEntry: (entry: MobileBootBatchEntry, signal: AbortSignal) => Promise<Buffer>,
    fingerprint: () => Promise<string>,
    maxBatches: number = MAX_MOBILE_BOOT_BATCHES,
    loadFallback?: (plan: MobileBootBatchPlan, signal: AbortSignal) => Promise<Buffer>,
  ) {
    this.loadEntry = loadEntry
    this.fingerprint = fingerprint
    this.maxBatches = maxBatches
    this.loadFallback = loadFallback
  }

  /**
   * Remember a plan, most recently planned last, evicting the oldest over the cap.
   * @param plan - Plan produced while rewriting a manifest.
   */
  remember(plan: MobileBootBatchPlan): void {
    const existing = this.batches.get(plan.key)
    this.batches.delete(plan.key)
    this.batches.set(plan.key, existing === undefined ? { plan } : { ...existing, plan })
    while (this.batches.size > this.maxBatches) {
      const oldest = this.batches.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.batches.delete(oldest)
    }
  }

  /**
   * Assemble the batch for a key, reusing the cached body while the fingerprint holds.
   * @param key - Batch key taken from `…/mobile-boot/<key>.js`.
   * @param signal - Aborts the upstream fetches.
   * @returns The body, its entity tag and a lazily built gzip view.
   */
  async render(key: string, signal: AbortSignal): Promise<MobileBootBatchPayload> {
    const stored = this.batches.get(key)
    if (stored === undefined) throw new HttpError(404, 'not_found')
    const fingerprint = await this.fingerprint()
    if (stored.body === undefined || stored.etag === undefined || stored.fingerprint !== fingerprint) {
      try {
        const assembled = await this.assemble(stored.plan, signal)
        stored.body = assembled
        delete stored.gzipBody
        stored.etag = createHash('sha256').update(assembled).digest('hex')
        stored.fingerprint = fingerprint
      } catch (error) {
        // A batch this plugin cannot assemble would otherwise cost the phone the
        // whole page, so the upstream's own combined request stands in for it —
        // complete, pruned modules included. It is deliberately not cached, so
        // the next request still tries to prune.
        if (this.loadFallback === undefined) throw error
        const body = await this.loadFallback(stored.plan, signal)
        return {
          body,
          etag: createHash('sha256').update(body).digest('hex'),
          gzipBody: async (): Promise<Buffer> => await gzipBuffer(body),
        }
      }
    }
    const body = stored.body
    return {
      body,
      etag: stored.etag,
      gzipBody: async (): Promise<Buffer> => stored.gzipBody ??= await gzipBuffer(body),
    }
  }

  private async assemble(plan: MobileBootBatchPlan, signal: AbortSignal): Promise<Buffer> {
    const bodies = new Array<Buffer>(plan.entries.length)
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < plan.entries.length) {
        const index = cursor++
        const entry = plan.entries[index]!
        bodies[index] = await this.loadEntry(entry, signal)
        if (bodies[index]!.byteLength > MAX_MOBILE_BOOT_ENTRY_BYTES) throw new HttpError(502, 'upstream_unavailable')
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, plan.entries.length) }, worker))
    const total = bodies.reduce((bytes, body) => bytes + body.byteLength + 2, 0)
    if (total > MAX_MOBILE_BOOT_BATCH_BYTES) throw new HttpError(502, 'upstream_unavailable')
    return Buffer.concat(bodies.flatMap(body => [body, Buffer.from('\n;\n')]))
  }
}

/** An assembled batch, as handed back by {@link MobileBootBatchStore.render}. */
export interface MobileBootBatchPayload {
  readonly body: Buffer
  readonly etag: string
  readonly gzipBody: () => Promise<Buffer>
}

/**
 * Answer one `…/mobile-boot/<key>.js` request with an assembled batch.
 * @param request - Incoming request, already authorized by the caller.
 * @param response - Response to write.
 * @param payload - Assembled batch.
 * @param tlsEnabled - Whether the security headers may assume HTTPS.
 */
export async function sendMobileBootBatch(
  request: IncomingMessage,
  response: ServerResponse,
  payload: MobileBootBatchPayload,
  tlsEnabled: boolean,
): Promise<void> {
  const compressed = acceptsGzip(request.headers['accept-encoding'])
  const body = compressed ? await payload.gzipBody() : payload.body
  const etag = compressed ? `${payload.etag}-gzip` : payload.etag
  const headers: OutgoingHttpHeaders = {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'private, no-cache',
    ETag: etag,
  }
  if (compressed) headers['Content-Encoding'] = 'gzip'
  addVaryAcceptEncoding(headers)
  setSecurityHeaders(response, tlsEnabled)
  if (headerValue(request.headers, 'if-none-match') === etag) {
    response.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache', Vary: String(headers.vary) })
    response.end()
    return
  }
  response.writeHead(200, headers)
  if (request.method === 'HEAD') response.end()
  else response.end(body)
}

function ensureMobileViewport(html: string): string {
  const viewport = /<meta\b(?=[^>]*\bname\s*=\s*["']viewport["'])[^>]*>/iu
  const match = viewport.exec(html)
  if (match === null) {
    const head = /<head\b[^>]*>/iu.exec(html)
    if (head?.index === undefined) return html
    const position = head.index + head[0].length
    return `${html.slice(0, position)}<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${html.slice(position)}`
  }
  if (/\bviewport-fit\s*=\s*cover\b/iu.test(match[0])) return html
  const content = /\bcontent\s*=\s*(["'])(.*?)\1/iu
  const next = content.test(match[0])
    ? match[0].replace(content, (_whole, quote: string, value: string) => `content=${quote}${value},viewport-fit=cover${quote}`)
    : match[0].replace(/\s*\/?>$/u, ' content="width=device-width,initial-scale=1,viewport-fit=cover">')
  return `${html.slice(0, match.index)}${next}${html.slice(match.index + match[0].length)}`
}

function orderAuthenticatedSettings(entries: BootGraphEntry[], slotsProvider: string): boolean {
  const mobile = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === MOBILE_CLIENT_MODULE)
  const settings = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === SETTINGS_MODULE)
  if (mobile.length === 0 || settings.length === 0) return false
  if (mobile.length !== 1 || settings.length !== 1) throw new Error('upstream DSH mobile settings graph is ambiguous')
  if (!Array.isArray(mobile[0]?.inject)
    || !mobile[0].inject.includes(CONNECTION_MODULE)
    || !mobile[0].inject.includes(SIDEBAR_MODULE)) {
    throw new Error('dsh-mobile client has unsupported dependencies')
  }
  // The settings module has to expose a dependency list we can extend, so that
  // it activates *after* this plugin has claimed the loopback trust hint that
  // settings reads exactly once while choosing its persistence backend.
  //
  // This used to also demand a `connection` dependency, which rejected a
  // healthy DSH 0.1.2 graph: settings moved to `remote.$host.isLoopback` and its
  // declared dependencies became `['@deepseek-ai/dsh-api-remotes']`. Requiring
  // the old edge would now fail the whole mobile page closed.
  if (!Array.isArray(settings[0]?.inject)) {
    throw new Error('upstream DSH settings module has unsupported dependencies')
  }
  // DSH 0.1.2 moved settings behind the Remote namespace. On that shape the
  // API gateway is what memoizes `$host` (see
  // MOBILE_AUTHENTICATED_TRANSPORT_BOOTSTRAP), so it must also arrive after
  // this plugin's client module instead of racing it.
  //
  // Applied opportunistically rather than as a validated requirement: the
  // pre-boot transport override above is what makes the trust correct on every
  // graph, so a DSH release that reshapes these entries should lose this extra
  // ordering edge, not fail the whole mobile page.
  const remoteSettings = !settings[0].inject.includes(CONNECTION_MODULE)
  if (remoteSettings) {
    for (const gateway of entries) {
      if (gateway === null || typeof gateway !== 'object' || gateway.id !== API_GATEWAY_MODULE) continue
      if (!Array.isArray(gateway.inject)) continue
      if (!gateway.inject.includes(CONNECTION_MODULE)) continue
      if (!gateway.inject.includes(MOBILE_CLIENT_MODULE)) gateway.inject = [...gateway.inject, MOBILE_CLIENT_MODULE]
    }
  }
  mobile[0].inject = [CONNECTION_MODULE, slotsProvider]
  if (!settings[0].inject.includes(MOBILE_CLIENT_MODULE)) settings[0].inject = [...settings[0].inject, MOBILE_CLIENT_MODULE]
  return remoteSettings
}

function revisionedMobileBatchPath(entries: readonly MobileBootBatchEntry[]): { readonly key: string; readonly path: string } {
  const key = createHash('sha256')
    .update(DSH_MOBILE_VERSION)
    .update(JSON.stringify(entries))
    .digest('hex')
  return { key, path: `${MOBILE_BOOT_BATCH_PREFIX}${key}.js` }
}

const BOOT_ASSIGNMENT = /(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*/u

/**
 * Marker the plugin injects only into pages it serves itself, so the mobile
 * client claims the loopback trust hint for its own channels and never for a
 * page reached through somebody else's reverse proxy.
 */
const MOBILE_TRUST_FLAG = 'window.__DSH_MOBILE_TRUSTED_GATEWAY__=true;'

interface BootManifestSite {
  readonly start: number
  readonly assignment: string
  readonly scriptEnd: number
  readonly parsed: { rev?: unknown; entries?: unknown; batches?: unknown }
}

/** Locate and validate the boot manifest literal inside an upstream DSH index. */
function locateBootManifest(html: string): BootManifestSite {
  const assignment = BOOT_ASSIGNMENT.exec(html)
  if (assignment?.index === undefined) throw new Error('upstream DSH index has no boot manifest')
  const valueStart = assignment.index + assignment[0].length
  const scriptEnd = html.indexOf('</script>', valueStart)
  if (scriptEnd < 0) throw new Error('upstream DSH boot manifest script is incomplete')
  const parsed = JSON.parse(html.slice(valueStart, scriptEnd).trim().replace(/;$/u, '')) as BootManifestSite['parsed']
  if (typeof parsed.rev !== 'string' || !Array.isArray(parsed.entries)) {
    throw new Error('upstream DSH boot manifest is malformed')
  }
  return { start: assignment.index, assignment: assignment[0], scriptEnd, parsed }
}

/** Resolve the unique stock layout module and its supported dependency profile. */
function requireLayoutModule(entries: BootGraphEntry[]): { readonly slots: string; readonly entry: BootGraphEntry } {
  const layout = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === MOBILE_LAYOUT_MODULE)
  if (layout.length !== 1 || typeof layout[0]?.url !== 'string' || typeof layout[0].rev !== 'string') {
    throw new Error('upstream DSH boot manifest has no unique layout module')
  }
  if (!Array.isArray(layout[0].inject)) {
    throw new Error('upstream DSH layout module has unsupported dependencies')
  }
  const dependencyProfile = MOBILE_LAYOUT_DEPENDENCY_PROFILES.find(profile => (
    profile.dependencies.every(dependency => layout[0]?.inject?.includes(dependency))
  ))
  if (dependencyProfile === undefined) throw new Error('upstream DSH layout module has unsupported dependencies')
  return { slots: dependencyProfile.slots, entry: layout[0] }
}

/**
 * Whether this plugin's dedicated layout module implements the upstream layout
 * generation the served manifest is built for.
 *
 * `mobile-layout.js` declares its own root children (`conversation`, `details`).
 * The generation marked by {@link LAYOUT_GENERATION_MARKER} replaced those with
 * `main` (keyed), `rightbar` and `shell.leading`, so substituting our module
 * there serves a page whose conversation is rendered into a slot nothing
 * declares — the phone shows no conversation at all. When the marker is present
 * the stock layout is left in place and the native surface adaptation carries the
 * phone, which is the arrangement the remote channel has always used.
 * @param entry - Boot-manifest entry for the upstream layout module.
 * @returns Whether replacing that entry with the dedicated layout is safe.
 */
function supportsDedicatedLayout(entry: BootGraphEntry): boolean {
  return !(Array.isArray(entry.inject) && entry.inject.includes(LAYOUT_GENERATION_MARKER))
}

/**
 * Which dedicated layout the served manifest should activate, if any.
 *
 * Two generations are implemented: `mobile-layout.js` declares the root's
 * children as `conversation`/`details`, which is what every DSH before the
 * current one built, and `mobile-layout-next.js` declares the current
 * generation's `main` (keyed), `rightbar` and `shell.leading`. Serving the wrong
 * one renders a page whose conversation lands in a slot nobody declares, so the
 * choice follows the upstream dependency profile and an explicit configuration
 * decides whether the current generation is replaced at all.
 * @param entry - Boot-manifest entry for the upstream layout module.
 * @param mode - `auto` (only generations this plugin implements), `mobile`
 * (also the current generation) or `stock` (never replace the layout).
 * @returns The path and revision to activate, or undefined for the stock layout.
 */

/**
 * Drop {@link DESKTOP_SHELL_ONLY_MODULES} and {@link MOBILE_BOOT_EXCLUDED_MODULES}
 * from the manifest before it is served.
 *
 * A batch whose entries are all pruned is dropped along with them, so a caller's
 * batch validation never sees an empty batch.
 * @param entries - Manifest entries, mutated in place.
 * @param batches - Manifest batches, mutated in place when present.
 * @returns Whether anything was removed.
 */
function pruneUnavailableClientModules(entries: BootGraphEntry[], batches: BootGraphBatch[] | undefined): boolean {
  const isPruned = (id: unknown): boolean => typeof id === 'string' && PRUNED_CLIENT_MODULES.includes(id)
  if (!entries.some(entry => entry !== null && typeof entry === 'object' && isPruned(entry.id))) return false
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isPruned(entries[index]?.id)) entries.splice(index, 1)
  }
  if (batches === undefined) return true
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index]
    if (batch === null || typeof batch !== 'object' || !Array.isArray(batch.entries)) continue
    batch.entries = batch.entries.filter(id => !isPruned(id))
    if (batch.entries.length === 0) batches.splice(index, 1)
  }
  return true
}

/**
 * Every client module the mobile channels refuse to ship, for any reason.
 */
const PRUNED_CLIENT_MODULES: readonly string[] = Object.freeze([
  ...DESKTOP_SHELL_ONLY_MODULES,
  ...MOBILE_BOOT_EXCLUDED_MODULES,
])

/**
 * The single pruned module a request asks for, when that is all it asks for.
 *
 * The served document names the pruned graph, but the page's module controller
 * is not driven by the document alone: `@deepseek-ai/dsh-client-hmr` subscribes
 * to the host's `/plugins/events` stream and applies every `{"type":"graph"}`
 * frame to its entry controller, which then loads whatever the stock graph lists
 * that the page has not loaded yet. On DSH 0.1.7 that pull measured 5,281,132
 * bytes for `@deepseek-ai/dsh-client-ui-settings-account` — the module this
 * plugin prunes from the document — arriving 526 ms after first paint, so
 * pruning the document did not stop the download by itself.
 *
 * A stock phase request combines many ids (`plugins/??id/client.js,…`) and the
 * upstream answers only the exact combination it built, so only requests naming a
 * single module are recognised here. No batch this plugin serves can contain a
 * pruned id, which leaves this the only spelling that can still reach upstream.
 * @param target - Raw request target, query and all.
 * @returns The pruned module id, when the target asks for exactly that module.
 */
export function prunedClientModuleRequest(target: string | undefined): string | undefined {
  if (target === undefined || !target.startsWith('/plugins/')) return undefined
  const ids = new Set<string>()
  for (const match of target.matchAll(/(?:@[^/,?&]+\/)?[^/,?&]+\/client\.js/gu)) {
    ids.add(match[0].slice(0, -'/client.js'.length))
    if (ids.size > 1) return undefined
  }
  const [id] = ids
  return id !== undefined && PRUNED_CLIENT_MODULES.includes(id) ? id : undefined
}

/**
 * Answer {@link prunedClientModuleRequest} with an inert registration instead of
 * the module itself.
 *
 * A bundle that never registers its id is a thrown import to the module
 * controller, so the module is registered as an empty namespace and exports
 * nothing. That keeps the controller's sync satisfied without the bytes.
 * @param request - Incoming request, for HEAD handling.
 * @param response - Response to write.
 * @param id - Pruned module id to register.
 * @param tlsEnabled - Whether the response must carry HSTS.
 */
export function sendPrunedClientModule(
  request: IncomingMessage,
  response: ServerResponse,
  id: string,
  tlsEnabled: boolean,
): void {
  const body = Buffer.from(
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: () => ({}) });\n`,
    'utf8',
  )
  setSecurityHeaders(response, tlsEnabled)
  response.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'private, no-cache',
  })
  if (request.method === 'HEAD') response.end()
  else response.end(body)
}

/**
 * Drop the document's preload hints for the stock combined boot requests.
 *
 * Upstream ships one `<link rel="preload" as="script">` per boot phase pointing at
 * the combination DSH itself built (`plugins/??id/client.js,…&rev=…`), next to the
 * manifest that names the batches to activate. Once this plugin serves its own
 * batches the two no longer agree, and the browser still fetches the hint: on DSH
 * 0.1.7 the two application-phase hints measured 18.8 MB of decoded script through
 * this plugin's own remote origin — including the 5,281,067-byte
 * `@deepseek-ai/dsh-client-ui-settings-account` module the served manifest no
 * longer lists. That is the whole pruned payload fetched a second time, which is
 * why pruning the manifest alone left a phone page just as heavy to load.
 *
 * The hints are dropped rather than rewritten: the client activates
 * `__DSH_BOOT__.batches`, whose urls this plugin answers from its own in-memory
 * store on a request that never leaves the machine, so there is nothing left for a
 * hint to warm.
 * @param html - Document slice that may contain stock boot preload hints.
 * @returns The slice without hints for a stock combined boot request.
 */
function dropStockBootPreloads(html: string): string {
  return html.replace(/<link\b[^>]*>/giu, (tag) => {
    if (!/\brel\s*=\s*["']?(?:module)?preload["']?/iu.test(tag)) return tag
    if (!/\bhref\s*=\s*["'][^"']*plugins\/\?\?[^"']*["']/iu.test(tag)) return tag
    return ''
  })
}

/**
 * Replace every combined batch in the manifest with one this plugin serves
 * itself, so the pruned modules never reach the phone.
 *
 * DSH fetches one combined request per phase (`plugins/??id/client.js,…`) and the
 * upstream server only answers the exact combinations it built, so a pruned
 * module cannot be dropped from a stock batch from the outside: the whole batch
 * has to be assembled and served here instead. Each plan keeps the stock request
 * it replaced so a caller can fall back to it.
 *
 * A batch that does not line up with the manifest is left alone rather than
 * failing the document: the phone keeps the stock batch and only loses the
 * pruning for it.
 * @param entries - Manifest entries, urls already final.
 * @param batches - Manifest batches, mutated in place.
 * @returns Plans to remember; empty when nothing could be planned.
 */
function planMobileBootBatches(entries: BootGraphEntry[], batches: BootGraphBatch[]): readonly MobileBootBatchPlan[] {
  const entryById = new Map<string, BootGraphEntry>()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') return Object.freeze([])
    if (entryById.has(entry.id)) return Object.freeze([])
    entryById.set(entry.id, entry)
  }
  const plans: MobileBootBatchPlan[] = []
  for (const batch of batches) {
    if (batch === null || typeof batch !== 'object'
      || (batch.phase !== 'bootstrap' && batch.phase !== 'application')
      || typeof batch.url !== 'string' || typeof batch.rev !== 'string'
      || !Array.isArray(batch.entries) || batch.entries.length === 0) continue
    const planEntries: MobileBootBatchEntry[] = []
    let usable = true
    for (const id of batch.entries) {
      const entry = typeof id === 'string' ? entryById.get(id) : undefined
      if (entry === undefined || typeof entry.url !== 'string' || typeof entry.rev !== 'string') {
        usable = false
        break
      }
      planEntries.push(Object.freeze({ id: entry.id, url: entry.url, rev: entry.rev }))
    }
    if (!usable) continue
    const upstream = Object.freeze({ url: batch.url, rev: batch.rev })
    const revision = revisionedMobileBatchPath(planEntries)
    batch.url = revision.path
    batch.rev = revision.key
    plans.push(Object.freeze({ ...revision, upstream, entries: Object.freeze(planEntries) }))
  }
  return Object.freeze(plans)
}



/**
 * Rewrite the mobile index for the pairing-free remote (Tailscale Serve) channel.
 *
 * The passthrough proxy owns that origin rather than this gateway, so the batch
 * plans are returned for the proxy to serve instead of going into the gateway's
 * own batch store. The stock layout module is left in place here — the remote
 * channel keeps DSH's own layout with the surface adaptation. The authenticated
 * -transport override, the trusted-gateway flag and the settings ordering are
 * applied because without them DSH resolves its settings to the in-memory
 * backend and the phone cannot load the model provider directory at all.
 *
 * The transport override is injected unconditionally here, not only on the
 * remote-backed settings graph: a page on a `*.ts.net` origin is never loopback,
 * and this channel has no second chance to correct the value once
 * `@deepseek-ai/dsh-api-gateway` has memoized `$host`. A DSH release that does
 * not read `__DSH_TRANSPORT__` simply ignores the global.
 * @param html - Upstream DSH index document.
 * @returns The document plus the batch plans the caller has to serve itself.
 */
export function rewriteRemoteMobileIndexWithBatches(html: string, layoutMode: MobileLayoutMode = 'auto'): RewrittenMobileIndex {
  const site = locateBootManifest(html)
  const entries = site.parsed.entries as BootGraphEntry[]
  const batches = Array.isArray(site.parsed.batches) ? site.parsed.batches as BootGraphBatch[] : undefined
  pruneUnavailableClientModules(entries, batches)
  const layout = requireLayoutModule(entries)
  // This channel has always kept DSH's own layout for the generation it already
  // replaced on the gateway (the proxy owns this origin and only started serving
  // a layout bundle for the current generation), so `auto` stays out of the way
  // and only the explicit opt-in replaces the current generation's frame.
  if (layoutMode === 'mobile' && !supportsDedicatedLayout(layout.entry)) {
    layout.entry.url = MOBILE_LAYOUT_NEXT_PATH
    layout.entry.rev = `dsh-mobile-layout-next-${DSH_MOBILE_VERSION}`
  }
  orderAuthenticatedSettings(entries, layout.slots)
  const mobileBatches = batches === undefined ? Object.freeze([]) : planMobileBootBatches(entries, batches)
  if (mobileBatches.length > 0) {
    site.parsed.rev = createHash('sha256').update(JSON.stringify({ entries, batches })).digest('hex').slice(0, 16)
  }
  const replacement = `${MOBILE_AUTHENTICATED_TRANSPORT_BOOTSTRAP}${MOBILE_SESSION_WINDOW_BOOTSTRAP}${MOBILE_TRUST_FLAG}${site.assignment}${JSON.stringify(site.parsed)};`
  return Object.freeze({
    html: ensureMobileViewport(`${dropStockBootPreloads(html.slice(0, site.start))}${replacement}${dropStockBootPreloads(html.slice(site.scriptEnd))}`),
    ...(mobileBatches.length === 0 ? {} : { batches: mobileBatches }),
  })
}

/**
 * Document-only view of {@link rewriteRemoteMobileIndexWithBatches} for callers
 * that do not serve the rewritten batches themselves.
 * @param html - Upstream DSH index document.
 * @returns The rewritten document.
 */
export function rewriteRemoteMobileIndex(html: string, layoutMode: MobileLayoutMode = 'auto'): string {
  return rewriteRemoteMobileIndexWithBatches(html, layoutMode).html
}




class ByteLimitTransform extends Transform {
  private total = 0

  constructor(private readonly maximum: number) {
    super()
  }

  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    this.total += buffer.length
    if (this.total > this.maximum) {
      callback(new HttpError(413, 'payload_too_large'))
      return
    }
    callback(null, buffer)
  }
}

export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}



export function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'ascii').digest('base64')
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? undefined : value
}



export function sanitizeRequestHeaders(
  request: IncomingMessage,
  upstream: URL,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    host: upstream.host,
  }
  if (request.headers.origin !== undefined) headers.origin = upstream.origin
  if (request.headers['sec-fetch-site'] !== undefined) headers['sec-fetch-site'] = 'same-origin'
  const allowed = [
    'accept', 'accept-encoding', 'accept-language', 'content-encoding', 'content-length', 'content-type',
    'if-match', 'if-modified-since', 'if-none-match', 'if-unmodified-since', 'range', 'user-agent',
  ] as const
  for (const name of allowed) {
    const value = request.headers[name]
    if (value !== undefined) headers[name] = value
  }
  return headers
}

const BLOCKED_RESPONSE_HEADERS = new Set([
  'alt-svc', 'cache-control', 'connection', 'content-security-policy', 'content-security-policy-report-only',
  'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'expires',
  'keep-alive', 'nel', 'permissions-policy', 'pragma', 'proxy-authenticate', 'referrer-policy',
  'report-to', 'reporting-endpoints', 'server', 'set-cookie', 'strict-transport-security', 'trailer',
  'transfer-encoding', 'upgrade', 'via', 'x-content-type-options', 'x-frame-options', 'x-powered-by',
])

export function sanitizeResponseHeaders(headers: IncomingHttpHeaders, upstream: URL): OutgoingHttpHeaders {
  const clean: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (value === undefined || BLOCKED_RESPONSE_HEADERS.has(lower) || lower.startsWith('access-control-')) continue
    if (lower === 'location' && typeof value === 'string') {
      try {
        const location = new URL(value, upstream)
        clean.location = location.origin === upstream.origin
          ? `${location.pathname}${location.search}${location.hash}`
          : value
      } catch {
        continue
      }
      continue
    }
    clean[lower] = value
  }
  return clean
}

function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return false
  let wildcard: boolean | undefined
  for (const entry of header.split(',')) {
    const [rawName, ...parameters] = entry.split(';')
    const name = rawName?.trim().toLowerCase()
    if (name === undefined || name === '') continue
    let quality = 1
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/iu.exec(parameter)
      if (match !== null) quality = Number(match[1])
    }
    if (name === 'gzip') return quality > 0
    if (name === '*') wildcard = quality > 0
  }
  return wildcard ?? false
}



/**
 * Long-lived caching for a revision-addressed response, when the request names
 * one.
 *
 * `sanitizeResponseHeaders` strips `cache-control` (and `expires`) from every
 * upstream response, so a channel that does not call this answers revisioned
 * assets with no validator and no freshness at all. A browser then has nothing
 * to revalidate against and re-downloads them on the next navigation: on DSH
 * 0.1.7 the phone channel re-fetched 5.66 MB of script and stylesheet bytes per
 * page load (3.24 MB mermaid, 0.67 MB three, vendor, shell) with a warm cache.
 *
 * Safe only because every URL this matches carries its own content identity: a
 * `/plugins/…?rev=<revision>` or `/assets/<name>-<hash>.<ext>` pair changes
 * whenever the bytes change.
 * @param request - Request whose target is inspected for a revision or hash.
 * @returns The cache-control value, or undefined for an unversioned response.
 */
export function revisionedStaticCacheControl(request: IncomingMessage): string | undefined {
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined
  let target: URL
  try { target = new URL(request.url ?? '/', 'https://dsh-mobile.invalid') } catch { return undefined }
  const revision = target.searchParams.get('rev')
  const hasRevision = revision !== null && /^[a-z0-9_-]{4,128}$/iu.test(revision)
  const hashedAsset = /^\/assets\/.*-[a-z0-9_-]{8,}\.[a-z0-9]+$/iu.test(target.pathname)
  if (!(target.pathname.startsWith('/plugins/') && hasRevision)
    && !(target.pathname.startsWith('/assets/') && (hasRevision || hashedAsset))) return undefined
  return 'private, max-age=31536000, immutable'
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mobileHistoryRequestBody(
  request: IncomingMessage,
  body: Buffer,
  pageMessages: number = MOBILE_HISTORY_PAGE_MESSAGES,
): Buffer {
  const target = request.url?.split('?', 1)[0] ?? ''
  if (request.method !== 'POST' || !SESSION_WINDOW_PATHS.includes(target)) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return body
  }
  if (!isJsonRecord(parsed) || !isJsonRecord(parsed.payload)) return body
  // DSH 0.1.7 nests the window under `payload.args.request`; the older
  // `session.history` spelling puts it directly on the payload.
  const args = isJsonRecord(parsed.payload.args) ? parsed.payload.args : undefined
  const nested = args !== undefined && isJsonRecord(args.request) ? args.request : undefined
  const holder = nested ?? parsed.payload
  const requested = holder.maxMessages
  if (typeof requested === 'number' && Number.isInteger(requested) && requested > 0 && requested <= pageMessages) {
    return body
  }
  const clamped: Record<string, unknown> = { ...holder, maxMessages: pageMessages }
  // The Turn window is a floor, not a bound: `paginate` keeps walking back to a
  // Turn boundary once the message count passes `minMessages`, so leaving it in
  // place lets a page grow past the size asked for (the phone's opening window
  // measured 291 records for `maxMessages: 50` because of it). Paging needs no
  // floor either — the journal stream asks for the next page by cursor.
  delete clamped.turnWindow
  const payload: Record<string, unknown> = nested === undefined
    ? { ...parsed.payload, ...clamped }
    : { ...parsed.payload, args: { ...args, request: clamped } }
  // The flat spelling carries the Turn window on the payload itself, so dropping
  // it from the clamped holder is not enough: the spread would keep the original.
  delete payload.turnWindow
  return Buffer.from(JSON.stringify({ ...parsed, payload }))
}

function addVaryAcceptEncoding(headers: OutgoingHttpHeaders): void {
  const existing = headers.vary
  const rawValues: string[] = Array.isArray(existing)
    ? existing.map(value => String(value))
    : existing === undefined ? [] : [String(existing)]
  const values = rawValues.flatMap(value => value.split(',').map(part => part.trim()).filter(Boolean))
  if (!values.some(value => value.toLowerCase() === 'accept-encoding')) values.push('Accept-Encoding')
  headers.vary = values.join(', ')
}


function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof MobileExtensionError) return new HttpError(error.status, error.code)
  return new HttpError(500, 'internal_error')
}




function extensionTarget(pathname: string):
  | { readonly kind: 'manifest' }
  | { readonly kind: 'script' | 'style' | 'asset'; readonly id: string; readonly path?: string }
  | { readonly kind: 'action'; readonly id: string; readonly action: string }
  | { readonly kind: 'route'; readonly id: string; readonly path: string }
  | undefined {
  const prefix = `${AUTH_PREFIX}/extensions`
  if (pathname === prefix || pathname === `${prefix}/` || pathname === `${prefix}/manifest`) return { kind: 'manifest' }
  if (!pathname.startsWith(`${prefix}/`)) return undefined
  const parts = pathname.slice(prefix.length + 1).split('/')
  const id = parts.shift()
  if (id === undefined || !/^[a-z][a-z0-9-]{0,63}$/u.test(id)) return undefined
  const leaf = parts.shift()
  if (leaf === 'mobile.js' && parts.length === 0) return { kind: 'script', id }
  if (leaf === 'mobile.css' && parts.length === 0) return { kind: 'style', id }
  if (leaf === 'assets' && parts.length > 0) return { kind: 'asset', id, path: parts.join('/') }
  if (leaf === 'actions' && parts.length === 1 && /^[a-z][a-z0-9-]{0,63}$/u.test(parts[0]!)) return { kind: 'action', id, action: parts[0]! }
  if (leaf === 'routes') return { kind: 'route', id, path: `/${parts.join('/')}`.replace(/\/{2,}/gu, '/') }
  return undefined
}

/**
 * Batch key of a `…/mobile-boot/<key>.js` pathname.
 * @param pathname - Decoded request pathname.
 * @returns The 64-hex key, or undefined for any other path.
 */
export function mobileBootBatchKey(pathname: string): string | undefined {
  const match = new RegExp(`^${MOBILE_BOOT_BATCH_PREFIX.replaceAll('/', '\\/')}([a-f\\d]{64})\\.js$`, 'u').exec(pathname)
  return match?.[1]
}

async function readBoundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    throw new HttpError(413, 'payload_too_large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximum) throw new HttpError(413, 'payload_too_large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function extensionRequestHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  const allowed = new Set(['accept', 'content-type', 'content-length', 'content-range', 'range', 'if-none-match', 'if-modified-since'])
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!allowed.has(name) || typeof value !== 'string') continue
    output[name] = value
  }
  return Object.freeze(output)
}

function extensionContentType(path: string): string {
  const type = {
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  }[extname(path).toLowerCase()]
  return type ?? 'application/octet-stream'
}
export interface MobileAssetRouteOptions {
  readonly customCssFile: string
  readonly customScriptFile: string
  readonly mobileLayoutFile: string
  readonly mobileLayoutNextFile: string
  readonly maxBodyBytes: number
  readonly extensions?: MobileAccessService
}

/**
 * The phone-frontend assets the remote (Tailscale Serve) channel needs: plugin
 * metadata, the custom css/js pair, the two layout modules and the custom
 * Web-file extension registry. Tailnet membership is the access control on
 * that channel, so no paired-device cookie is involved; host-side extension
 * actions and routes still run their own checks.
 */
export class MobileAssetRoute {
  private readonly options: MobileAssetRouteOptions
  private readonly extensions: MobileAccessService | undefined

  constructor(options: MobileAssetRouteOptions) {
    this.options = options
    this.extensions = options.extensions
  }

  route(): WebRoute {
    return {
      kind: 'prefix',
      path: AUTH_PREFIX,
      handler: async (request, response) => {
        try {
          const target = parseRequestTarget(request.url)
          if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/metadata`) {
            sendJson(response, 200, {
              version: MOBILE_METADATA_VERSION,
              pluginVersion: DSH_MOBILE_VERSION,
            }, false)
            return
          }
          const customAsset = request.method === 'GET'
            ? target.decodedPathname === `${AUTH_PREFIX}/custom.css`
              ? { file: this.options.customCssFile, contentType: 'text/css; charset=utf-8', fallback: CUSTOM_STYLE_FALLBACK }
              : target.decodedPathname === `${AUTH_PREFIX}/custom.js`
                ? { file: this.options.customScriptFile, contentType: 'text/javascript; charset=utf-8', fallback: CUSTOM_SCRIPT_FALLBACK }
                : target.decodedPathname === MOBILE_LAYOUT_PATH
                  ? { file: this.options.mobileLayoutFile, contentType: 'text/javascript; charset=utf-8', fallback: undefined }
                  : target.decodedPathname === MOBILE_LAYOUT_NEXT_PATH
                    ? { file: this.options.mobileLayoutNextFile, contentType: 'text/javascript; charset=utf-8', fallback: undefined }
                    : undefined
            : undefined
          const requestedExtension = extensionTarget(target.decodedPathname)
          if (customAsset === undefined && requestedExtension === undefined) throw new HttpError(404, 'not_found')
          if (requestedExtension !== undefined) {
            await this.handleExtensionRequest(requestedExtension, target, request, response)
            return
          }
          const operation = this.beginOperation(response)
          try {
            let body: Buffer
            let mtime: Date | undefined
            try {
              body = await readFile(customAsset!.file, { signal: operation.signal })
              try {
                const fileStat = await stat(customAsset!.file)
                mtime = fileStat.mtime
              } catch { /* keep undefined */ }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              if (customAsset!.fallback === undefined) throw new HttpError(503, 'mobile_frontend_unavailable')
              body = Buffer.from(customAsset!.fallback)
            }
            if (body.byteLength > 256 * 1024) throw new HttpError(413, 'payload_too_large')
            const etag = createHash('sha256').update(body).digest('hex')
            if (headerValue(request.headers, 'if-none-match') === etag) {
              setSecurityHeaders(response, false)
              response.writeHead(304)
              response.end()
              return
            }
            setSecurityHeaders(response, false)
            const responseHeaders: Record<string, string | number> = {
              'Content-Type': customAsset!.contentType,
              'Content-Length': body.byteLength,
              'ETag': etag,
            }
            if (mtime !== undefined) responseHeaders['Last-Modified'] = mtime.toUTCString()
            response.writeHead(200, responseHeaders)
            if (request.method === 'HEAD') response.end()
            else response.end(body)
          } finally {
            operation.release()
          }
        } catch (error) {
          const detail = error instanceof Error ? ` (${error.message})` : ''
          process.stderr.write(`[dsh-mobile-tailscale] mobile asset route failed for ${request.method ?? '?'} ${request.url}: ${error instanceof HttpError ? error.code : 'internal_error'}${detail}\n`)
          const mapped = mapError(error)
          if (response.headersSent) response.destroy()
          else sendFailure(response, mapped.status, mapped.code, false)
        }
      },
    }
  }

  /** Abort in-flight reads when the client goes away before the response ends. */
  private beginOperation(response: ServerResponse): { readonly signal: AbortSignal; readonly release: () => void } {
    const controller = new AbortController()
    const abort = (): void => { controller.abort(new Error('client closed the request')) }
    response.once('close', abort)
    return {
      signal: controller.signal,
      release: () => { response.off('close', abort) },
    }
  }
  private async handleExtensionRequest(
    targetInfo: NonNullable<ReturnType<typeof extensionTarget>>,
    target: ReturnType<typeof parseRequestTarget>,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const extensions = this.extensions
    if (extensions === undefined) throw new HttpError(404, 'not_found')
    if (targetInfo.kind === 'manifest') {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed')
      const operation = this.beginOperation(response)
      try {
        operation.signal.throwIfAborted()
        const customRevision = async (file: string, fallback: string): Promise<string> => {
          let source: Buffer
          try {
            source = await readFile(file, { signal: operation.signal })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            source = Buffer.from(fallback)
          }
          if (source.byteLength > 256 * 1024) throw new HttpError(413, 'payload_too_large')
          return createHash('sha256').update(source).digest('hex')
        }
        const [scriptRevision, styleRevision] = await Promise.all([
          customRevision(this.options.customScriptFile, CUSTOM_SCRIPT_FALLBACK),
          customRevision(this.options.customCssFile, CUSTOM_STYLE_FALLBACK),
        ])
        const body = Buffer.from(JSON.stringify({
          protocol: 1,
          extensions: extensions.manifest(),
          legacy: { scriptRevision, styleRevision },
        }))
        // The ETag must cover extension content, not just the manifest body, so
        // editing mobile.js/css alone invalidates the client's cached manifest.
        const etag = createHash('sha256').update(body).update(extensions.contentDigest()).digest('hex')
        if (headerValue(request.headers, 'if-none-match') === etag) {
          setSecurityHeaders(response, false); response.writeHead(304); response.end(); return
        }
        setSecurityHeaders(response, false)
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.byteLength, ETag: etag })
        if (request.method === 'HEAD') response.end(); else response.end(body)
        return
      } finally {
        operation.release()
      }
    }
    if (targetInfo.kind === 'script' || targetInfo.kind === 'style' || targetInfo.kind === 'asset') {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed')
      const operation = this.beginOperation(response)
      try {
        const file = targetInfo.kind === 'script'
          ? await extensions.readClientFile(targetInfo.id, 'script', operation.signal)
          : targetInfo.kind === 'style'
            ? await extensions.readClientFile(targetInfo.id, 'style', operation.signal)
            : await extensions.readAsset(targetInfo.id, targetInfo.path ?? '', operation.signal)
        if (headerValue(request.headers, 'if-none-match') === file.digest) {
          setSecurityHeaders(response, false); response.writeHead(304); response.end(); return
        }
        const contentType = targetInfo.kind === 'script'
          ? 'text/javascript; charset=utf-8'
          : targetInfo.kind === 'style' ? 'text/css; charset=utf-8' : extensionContentType(targetInfo.path ?? '')
        setSecurityHeaders(response, false)
        response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': file.body.byteLength, ETag: file.digest })
        if (request.method === 'HEAD') response.end(); else response.end(file.body)
        return
      } finally {
        operation.release()
      }
    }
    if (targetInfo.kind === 'action') {
      if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
      const body = await readJsonObject(request, 1024 * 1024)
      const operation = this.beginOperation(response)
      const abort = new AbortController()
      response.once('close', () => { abort.abort() })
      const generationSignal = extensions.signal(targetInfo.id)
      const onGenerationAbort = (): void => { abort.abort(); if (!response.destroyed) response.destroy() }
      generationSignal?.addEventListener('abort', onGenerationAbort, { once: true })
      try {
        const result = await extensions.invoke(targetInfo.id, targetInfo.action, body, { signal: abort.signal, deviceId: 'remote' })
        let serialized: Buffer
        try { serialized = Buffer.from(JSON.stringify(result)) } catch { throw new MobileExtensionError('extension_failed', 'extension action failed', 500) }
        if (serialized.byteLength > 4 * 1024 * 1024) throw new MobileExtensionError('extension_result_too_large', 'extension result is too large', 500)
        sendJson(response, 200, result, false)
      } finally {
        generationSignal?.removeEventListener('abort', onGenerationAbort)
        abort.abort(); operation.release()
      }
      return
    }
    if (targetInfo.kind === 'route') {
      const method = request.method ?? 'GET'
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new HttpError(405, 'method_not_allowed')
      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBoundedBody(request, this.options.maxBodyBytes)
      const operation = this.beginOperation(response)
      const abort = new AbortController()
      response.once('close', () => { abort.abort() })
      const generationSignal = extensions.signal(targetInfo.id)
      const onGenerationAbort = (): void => { abort.abort(); if (!response.destroyed) response.destroy() }
      generationSignal?.addEventListener('abort', onGenerationAbort, { once: true })
      try {
        const parsed = new URL(target.raw, 'http://localhost')
        const routeRequest: MobileRouteRequest = {
          method, pathname: targetInfo.path, query: parsed.searchParams,
          headers: extensionRequestHeaders(request.headers), body, signal: abort.signal, deviceId: 'remote',
        }
        const result = await extensions.route(targetInfo.id, method, targetInfo.path, routeRequest)
        await this.sendExtensionResponse(response, result, request.method === 'HEAD')
      } finally {
        generationSignal?.removeEventListener('abort', onGenerationAbort)
        abort.abort(); operation.release()
      }
    }
  }

  private async sendExtensionResponse(response: ServerResponse, result: MobileRouteResponse, head: boolean): Promise<void> {
    const contentType = result.contentType ?? 'application/octet-stream'
    if (!/^[\w!#$&+.^-]+\/[\w!#$&+.^-]+(?:;[\s\S]*)?$/u.test(contentType)) throw new MobileExtensionError('invalid_route_response', 'extension returned an invalid content type', 500)
    const safeHeaders: Record<string, string> = {}
    for (const [name, value] of Object.entries(result.headers ?? {})) {
      if (!/^(?:content-disposition|cache-control|etag)$/iu.test(name) || /[\r\n]/u.test(value)) continue
      safeHeaders[name] = value
    }
    setSecurityHeaders(response, false)
    if (typeof result.body === 'string' || result.body instanceof Uint8Array) {
      const body = typeof result.body === 'string' ? Buffer.from(result.body) : Buffer.from(result.body)
      if (body.byteLength > 4 * 1024 * 1024) throw new MobileExtensionError('extension_result_too_large', 'extension response is too large', 500)
      response.writeHead(result.status ?? 200, { ...safeHeaders, 'Content-Type': contentType, 'Content-Length': body.byteLength })
      if (head) response.end(); else response.end(body)
      return
    }
    response.writeHead(result.status ?? 200, { ...safeHeaders, 'Content-Type': contentType })
    if (head) { result.body.destroy(); response.end(); return }
    await pipeline(result.body, new ByteLimitTransform(4 * 1024 * 1024), response)
  }
}
