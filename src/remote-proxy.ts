/**
 * Remote passthrough proxy: a loopback HTTP server that forwards to the live
 * DSH web upstream while rewriting `Host`/`Origin` to the upstream origin, so
 * the DSH browser-trust fence accepts the proxied requests — the same proven
 * pattern the LAN gateway uses. Tailscale Serve points at this proxy, and the
 * proxy resolves the upstream per request (preferring `DSH_WEB_URL`), so the
 * remote channel follows desktop/CLI port changes automatically, with no
 * manual re-pointing after restarts.
 *
 * This proxy is deliberately small and pairing-free: tailnet membership is the
 * access control for the remote channel, matching the dsh-mobile-tailscale
 * design. It mirrors the gateway's request sanitization, session-cookie
 * injection, and WebSocket handshake rewriting.
 * @module dsh-mobile-tailscale/remote-proxy
 */

import {
  createServer as createHttpServer,
  request as requestHttp,
  STATUS_CODES,
  type ClientRequest,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { connect, type Socket } from 'node:net'
import {
  HttpError,
  parseRequestTarget,
  sendFailure,
} from './http-security.js'
import {
  rewriteRemoteMobileIndex,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  stripIpv6Brackets,
  websocketAccept,
} from './gateway.js'

const MAX_HEADER_BYTES = 16 * 1024
/** Largest upstream document this proxy will buffer in order to rewrite it. */
const MAX_REWRITABLE_INDEX_BYTES = 512 * 1024
/** Absolute bound on a buffered HTML document before the proxy gives up. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
/** Same shape as the gateway's upstream session-cookie validation. */
const UPSTREAM_COOKIE_PAIR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21-\x3A\x3C-\x7E]*$/u
const UPSTREAM_AUTH_REFRESH_MARGIN_MS = 30_000
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_WEB_SOCKETS = 32

/** Construction inputs for one remote passthrough proxy lifecycle. */
export interface RemotePassthroughProxyOptions {
  /** Resolve the live DSH web upstream for a proxied request. */
  readonly resolveUpstream: () => URL
  /** Produce the authenticated session URL for the given upstream origin, if available. */
  readonly resolveAuthenticatedUrl?: (upstream: URL) => string | undefined
  readonly upstreamTimeoutMs?: number
  readonly maxBodyBytes?: number
  readonly maxWebSockets?: number
}

interface ActiveWebSocket {
  readonly client: Socket
  readonly upstream: Socket
}

function hasUpgradeToken(header: string | undefined): boolean {
  return (header ?? '')
    .split(',')
    .some(token => token.trim().toLowerCase() === 'upgrade')
}

function httpStatusText(status: number): string {
  return STATUS_CODES[status] ?? 'Error'
}

/**
 * Owns one loopback listener used as the Tailscale Serve target. It resolves
 * the upstream per request so the serve config (which targets this proxy's
 * stable loopback port) does not need to change when the DSH web instance
 * moves ports.
 */
export class RemotePassthroughProxy {
  private server: HttpServer | undefined
  private port = 0
  private readonly sockets = new Set<Socket>()
  private readonly webSockets = new Set<ActiveWebSocket>()
  private upstreamCookiePair: string | undefined
  private upstreamCookieOrigin: string | undefined
  private upstreamCookieExpiresAt = 0
  private upstreamCookieTask: Promise<string | undefined> | undefined

  constructor(private readonly options: RemotePassthroughProxyOptions) {}

  /** Bind the loopback listener. Idempotent: a running proxy is left alone. */
  async start(): Promise<void> {
    if (this.server !== undefined && this.server.listening) return
    const server = createHttpServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        const mapped = error instanceof HttpError ? error : new HttpError(502, 'upstream_unavailable')
        const detail = error instanceof Error ? ` (${error.message})` : ''
        process.stderr.write(`[dsh-mobile-tailscale] remote proxy request failed for ${request.method ?? '?'} ${request.url}: ${mapped.code}${detail}\n`)
        sendFailure(response, mapped.status, mapped.code, false)
      })
    })
    server.on('connect', (_request, socket) => {
      socket.destroy()
    })
    server.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket as Socket, head).catch((error) => {
        const mapped = error instanceof HttpError ? error : new HttpError(502, 'upstream_unavailable')
        const detail = error instanceof Error ? ` (${error.message})` : ''
        // Diagnostic channel: the desktop harness captures stderr into its log.
        process.stderr.write(`[dsh-mobile-tailscale] remote proxy upgrade failed for ${request.url}: ${mapped.code}${detail}\n`)
        this.rejectUpgrade(socket as Socket, mapped.status, mapped.code)
      })
    })
    server.on('clientError', (_error, socket) => {
      socket.destroy()
    })
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('error', () => { socket.destroy() })
      socket.once('close', () => { this.sockets.delete(socket) })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        server.off('error', reject)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('remote proxy could not bind a loopback port'))
          return
        }
        this.port = address.port
        resolve()
      })
    })
    this.server = server
  }

  /** Loopback origin of this proxy — the stable Tailscale Serve target. */
  origin(): string {
    if (this.server === undefined || !this.server.listening || this.port === 0) {
      throw new Error('remote proxy is not listening')
    }
    return `http://127.0.0.1:${String(this.port)}`
  }

  /** Tear down the listener and every active connection. Idempotent. */
  async close(): Promise<void> {
    for (const active of [...this.webSockets]) {
      active.client.destroy()
      active.upstream.destroy()
    }
    this.webSockets.clear()
    for (const socket of [...this.sockets]) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = undefined
    this.port = 0
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = parseRequestTarget(request.url)
    const method = request.method ?? 'GET'
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new HttpError(405, 'method_not_allowed')
    }
    const body = method === 'GET' || method === 'HEAD'
      ? Buffer.alloc(0)
      : await this.readBoundedBody(request)
    const upstream = this.options.resolveUpstream()
    const upstreamHeaders = sanitizeRequestHeaders(request, upstream)
    // The document is rewritten below, so it has to arrive uncompressed.
    const document = method === 'GET' && target.decodedPathname === '/'
    if (document) upstreamHeaders['accept-encoding'] = 'identity'
    const upstreamCookie = await this.upstreamCookieFor(upstream)
    if (upstreamCookie !== undefined) upstreamHeaders.cookie = upstreamCookie
    const proxied = await new Promise<IncomingMessage>((resolve, reject) => {
      const upstreamRequest: ClientRequest = requestHttp({
        protocol: 'http:',
        hostname: stripIpv6Brackets(upstream.hostname),
        port: Number(upstream.port),
        method,
        path: target.raw,
        headers: upstreamHeaders,
        agent: false,
      })
      upstreamRequest.setTimeout(this.upstreamTimeoutMs(), () => {
        upstreamRequest.destroy(new Error('upstream timeout'))
      })
      upstreamRequest.once('response', resolve)
      upstreamRequest.once('error', reject)
      if (body.length > 0) upstreamRequest.write(body)
      upstreamRequest.end()
    })
    if (document && await this.serveRewrittenDocument(proxied, response, upstream)) return
    const headers = sanitizeResponseHeaders(proxied.headers, upstream)
    response.writeHead(proxied.statusCode ?? 502, headers)
    if (method === 'HEAD') {
      proxied.resume()
      response.end()
      return
    }
    await new Promise<void>((resolve, reject) => {
      proxied.once('error', reject)
      response.once('error', reject)
      proxied.pipe(response)
      proxied.once('end', resolve)
    })
  }

  /**
   * Serve the upstream document with the mobile settings ordering applied.
   *
   * DSH answers the document with `Transfer-Encoding: chunked` and no
   * `Content-Length`, so the body is buffered up to a bound instead of being
   * gated on a declared size — gating on one silently skipped every rewrite.
   *
   * The remote channel runs DSH's own layout, so only the trusted-gateway flag
   * and the settings ordering are injected here: without them DSH resolves its
   * settings to the in-memory backend, and the phone's model provider directory
   * fails to load. A non-HTML body or a failed rewrite is passed straight
   * through — a stock page still works, and failing closed would take the whole
   * remote channel down with it.
   * @returns Whether this response was already written.
   */
  private async serveRewrittenDocument(
    proxied: IncomingMessage,
    response: ServerResponse,
    upstream: URL,
  ): Promise<boolean> {
    if ((proxied.statusCode ?? 502) !== 200) return false
    const type = proxied.headers['content-type']
    if (typeof type !== 'string' || !type.toLowerCase().includes('text/html')) return false
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of proxied) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      total += buffer.length
      // The application document is tens of kilobytes; a runaway body is not
      // the document this rewrite expects.
      if (total > MAX_DOCUMENT_BYTES) throw new HttpError(502, 'upstream_document_too_large')
      chunks.push(buffer)
    }
    const raw = Buffer.concat(chunks)
    const encoded = proxied.headers['content-encoding']
    const rewritable = raw.length <= MAX_REWRITABLE_INDEX_BYTES
      && (encoded === undefined || encoded === 'identity')
    let body = raw
    if (rewritable) {
      try {
        body = Buffer.from(rewriteRemoteMobileIndex(raw.toString('utf8')))
      } catch (error) {
        process.stderr.write(`[dsh-mobile-tailscale] remote proxy served the stock document: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    const headers = sanitizeResponseHeaders(proxied.headers, upstream)
    headers['content-length'] = String(body.length)
    response.writeHead(proxied.statusCode ?? 502, headers)
    response.end(body)
    return true
  }

  private async handleUpgrade(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const target = parseRequestTarget(request.url)
    // Transparent passthrough: forward every upgrade request as-is (path and
    // query included). The upstream DSH web server owns the trust fence and
    // decides which WebSocket channels to accept, so a whitelist here would
    // only break legitimate plugin channels (e.g. /sidebar/ws/*).
    if (request.method !== 'GET' || String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket'
      || !hasUpgradeToken(request.headers.connection)) {
      throw new HttpError(400, 'bad_request')
    }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string' || request.headers['sec-websocket-version'] !== '13') {
      throw new HttpError(400, 'bad_request')
    }
    let decodedKey: Buffer
    try {
      decodedKey = Buffer.from(key, 'base64')
    } catch {
      throw new HttpError(400, 'bad_request')
    }
    if (decodedKey.length !== 16 || decodedKey.toString('base64') !== key) throw new HttpError(400, 'bad_request')
    if (this.webSockets.size >= (this.options.maxWebSockets ?? DEFAULT_MAX_WEB_SOCKETS)) {
      throw new HttpError(429, 'busy')
    }
    const upstream = this.options.resolveUpstream()
    const upstreamCookie = await this.upstreamCookieFor(upstream)
    const upstreamSocket = connect({
      host: stripIpv6Brackets(upstream.hostname),
      port: Number(upstream.port),
    })
    client.pause()
    const closeBoth = (): void => {
      client.destroy()
      upstreamSocket.destroy()
    }
    client.on('error', closeBoth)
    upstreamSocket.on('error', closeBoth)
    const active: ActiveWebSocket = { client, upstream: upstreamSocket }
    this.webSockets.add(active)
    const cleanup = (): void => {
      this.webSockets.delete(active)
    }
    const onClientClose = (): void => { upstreamSocket.destroy(); cleanup() }
    const onUpstreamClose = (): void => { client.destroy(); cleanup() }
    client.once('close', onClientClose)
    upstreamSocket.once('close', onUpstreamClose)
    upstreamSocket.setTimeout(this.upstreamTimeoutMs(), closeBoth)
    try {
      await new Promise<void>((resolve, reject) => {
        const connected = (): void => {
          upstreamSocket.off('error', failed)
          resolve()
        }
        const failed = (error: Error): void => {
          upstreamSocket.off('connect', connected)
          reject(error)
        }
        upstreamSocket.once('connect', connected)
        upstreamSocket.once('error', failed)
      })
      const requestLines = [
        `GET ${target.raw} HTTP/1.1`,
        `Host: ${upstream.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Origin: ${upstream.origin}`,
        'Sec-Fetch-Site: same-origin',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ]
      if (upstreamCookie !== undefined) requestLines.push(`Cookie: ${upstreamCookie}`)
      const protocol = request.headers['sec-websocket-protocol']
      const extensions = request.headers['sec-websocket-extensions']
      if (protocol !== undefined) requestLines.push(`Sec-WebSocket-Protocol: ${protocol}`)
      if (extensions !== undefined) requestLines.push(`Sec-WebSocket-Extensions: ${extensions}`)
      requestLines.push('', '')
      upstreamSocket.write(requestLines.join('\r\n'))
      if (head.length > 0) upstreamSocket.write(head)
      const handshake = await this.readUpgradeResponse(upstreamSocket, websocketAccept(key))
      upstreamSocket.setTimeout(0)
      client.write(handshake.header)
      if (handshake.remainder.length > 0) client.write(handshake.remainder)
      upstreamSocket.pipe(client)
      client.pipe(upstreamSocket)
      client.resume()
    } catch (error) {
      // Destroy only the upstream here: the upgrade wiring above still needs
      // the client socket to write the error response. Destroying the client
      // first silently swallowed every upgrade failure as an EOF.
      upstreamSocket.off('close', onUpstreamClose)
      upstreamSocket.destroy()
      cleanup()
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'upstream_unavailable')
    }
  }

  /** Resolve and cache the upstream session cookie for the current origin. */
  private async upstreamCookieFor(upstream: URL): Promise<string | undefined> {
    const resolver = this.options.resolveAuthenticatedUrl
    if (resolver === undefined) return undefined
    if (this.upstreamCookiePair !== undefined
      && this.upstreamCookieOrigin === upstream.origin
      && this.upstreamCookieExpiresAt > Date.now() + UPSTREAM_AUTH_REFRESH_MARGIN_MS) {
      return this.upstreamCookiePair
    }
    if (this.upstreamCookieTask !== undefined) return this.upstreamCookieTask
    const task = this.exchangeUpstreamCookie(upstream, resolver)
    this.upstreamCookieTask = task
    try {
      return await task
    } finally {
      if (this.upstreamCookieTask === task) this.upstreamCookieTask = undefined
    }
  }

  /**
   * Exchange the upstream's session cookie through its authenticated URL.
   * Non-fatal by design: without a session cookie the remote channel still
   * serves the web app (availability first); the diagnostics surface it.
   */
  private async exchangeUpstreamCookie(
    upstream: URL,
    resolver: (origin: URL) => string | undefined,
  ): Promise<string | undefined> {
    let authenticatedUrl: string | undefined
    try {
      authenticatedUrl = resolver(upstream)
    } catch {
      // A throwing authenticator must never break the remote channel; the
      // cookie is an enhancement, not a requirement.
      return undefined
    }
    if (authenticatedUrl === undefined) return undefined
    let target: URL
    try {
      target = new URL(authenticatedUrl)
    } catch {
      return undefined
    }
    if (target.origin !== upstream.origin || target.pathname !== '/'
      || target.hash !== '' || target.search === '') {
      return undefined
    }
    try {
      const proxied = await new Promise<IncomingMessage>((resolve, reject) => {
        const upstreamRequest = requestHttp({
          protocol: 'http:',
          hostname: stripIpv6Brackets(upstream.hostname),
          port: Number(upstream.port),
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers: {
            host: upstream.host,
            accept: 'text/html',
            'accept-encoding': 'identity',
          },
          agent: false,
        })
        upstreamRequest.setTimeout(this.upstreamTimeoutMs(), () => {
          upstreamRequest.destroy(new Error('upstream timeout'))
        })
        upstreamRequest.once('response', resolve)
        upstreamRequest.once('error', reject)
        upstreamRequest.end()
      })
      await new Promise<void>((resolve, reject) => {
        proxied.once('end', resolve)
        proxied.once('error', reject)
        proxied.resume()
      })
      const setCookie = proxied.headers['set-cookie']?.[0]
      const pair = setCookie?.split(';', 1)[0]
      const maxAgeText = setCookie === undefined
        ? undefined
        : /(?:^|;\s*)Max-Age=(\d+)(?:;|$)/iu.exec(setCookie)?.[1]
      const maxAgeSeconds = maxAgeText === undefined ? Number.NaN : Number(maxAgeText)
      const expiresAt = Date.now() + maxAgeSeconds * 1000
      if (proxied.statusCode !== 303 || pair === undefined || pair.length > 4096
        || !UPSTREAM_COOKIE_PAIR.test(pair) || !Number.isSafeInteger(expiresAt)
        || maxAgeSeconds <= 0) {
        return undefined
      }
      this.upstreamCookiePair = pair
      this.upstreamCookieOrigin = upstream.origin
      this.upstreamCookieExpiresAt = expiresAt
      return pair
    } catch {
      return undefined
    }
  }

  private readUpgradeResponse(
    upstream: Socket,
    expectedAccept: string,
  ): Promise<{ header: string; remainder: Buffer }> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { cleanup(); reject(new Error('upstream closed during WebSocket handshake')) }
      const data = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > MAX_HEADER_BYTES) {
          failed(new Error('upstream WebSocket headers are too large'))
          return
        }
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        cleanup()
        const lines = buffer.subarray(0, end).toString('latin1').split('\r\n')
        if (lines.shift() !== 'HTTP/1.1 101 Switching Protocols') {
          reject(new Error('upstream refused WebSocket upgrade'))
          return
        }
        const selected = new Map<string, string>()
        for (const line of lines) {
          const colon = line.indexOf(':')
          if (colon <= 0) {
            reject(new Error('upstream returned malformed WebSocket headers'))
            return
          }
          const name = line.slice(0, colon).trim().toLowerCase()
          const value = line.slice(colon + 1).trim()
          if (selected.has(name)) {
            reject(new Error('upstream returned duplicate WebSocket headers'))
            return
          }
          selected.set(name, value)
        }
        if (selected.get('upgrade')?.toLowerCase() !== 'websocket'
          || !hasUpgradeToken(selected.get('connection'))
          || selected.get('sec-websocket-accept') !== expectedAccept) {
          reject(new Error('upstream returned an invalid WebSocket handshake'))
          return
        }
        const output = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${expectedAccept}`,
        ]
        const protocol = selected.get('sec-websocket-protocol')
        const extensions = selected.get('sec-websocket-extensions')
        if (protocol !== undefined) output.push(`Sec-WebSocket-Protocol: ${protocol}`)
        if (extensions !== undefined) output.push(`Sec-WebSocket-Extensions: ${extensions}`)
        output.push('Referrer-Policy: no-referrer', 'X-Content-Type-Options: nosniff', '', '')
        resolve({ header: output.join('\r\n'), remainder: buffer.subarray(end + 4) })
      }
      const cleanup = (): void => {
        upstream.off('data', data)
        upstream.off('error', failed)
        upstream.off('close', closed)
      }
      upstream.on('data', data)
      upstream.once('error', failed)
      upstream.once('close', closed)
    })
  }

  private rejectUpgrade(socket: Socket, status: number, code: string): void {
    if (socket.destroyed) return
    const reason = `DSH Mobile remote proxy: ${code}`
    socket.end([
      `HTTP/1.1 ${status} ${httpStatusText(status)}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(reason)}`,
      '',
      reason,
    ].join('\r\n'))
  }

  private async readBoundedBody(request: IncomingMessage): Promise<Buffer> {
    const maximum = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maximum) throw new HttpError(413, 'payload_too_large')
      chunks.push(buffer)
    }
    return Buffer.concat(chunks)
  }

  private upstreamTimeoutMs(): number {
    return this.options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS
  }
}
