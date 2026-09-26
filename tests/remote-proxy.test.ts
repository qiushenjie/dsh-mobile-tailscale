import { once } from 'node:events'
import {
  createServer as createHttpServer,
  request as requestHttp,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemotePassthroughProxy } from '../src/remote-proxy.js'
import { websocketAccept } from '../src/mobile-frontend.js'
import { resolveLiveUpstream } from '../src/upstream.js'

const packageName = (createRequire(import.meta.url)('../package.json') as { name: string }).name

/** A DSH-shaped document whose settings module declares only the remotes namespace. */
function bootDocument(): string {
  const entries = [
    { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/connection.js', rev: 'c', inject: [] },
    { id: '@deepseek-ai/dsh-client-ui-renderer', url: '/plugins/renderer.js', rev: 'r', inject: [] },
    {
      id: '@deepseek-ai/dsh-client-ui-layout',
      url: '/plugins/layout.js',
      rev: 'l',
      inject: [
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-ui-session',
        '@deepseek-ai/dsh-client-ui-theme',
      ],
    },
    { id: '@deepseek-ai/dsh-client-ui-settings', url: '/plugins/settings.js', rev: 's', inject: ['@deepseek-ai/dsh-api-remotes'] },
    {
      id: packageName,
      url: '/plugins/mobile.js',
      rev: 'm',
      inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
      immediately: true,
    },
  ]
  return `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'stock', entries })};</script></head><body>app</body></html>`
}

const proxies: RemotePassthroughProxy[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(proxies.splice(0).map(proxy => proxy.close()))
  await Promise.all(servers.splice(0).map(server => server.close()))
  vi.unstubAllEnvs()
})

async function listen(server: HttpServer, host = '127.0.0.1'): Promise<number> {
  server.listen({ host, port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no listener port')
  return address.port
}

function trackServer(server: HttpServer): { close: () => Promise<void> } {
  const handle = { close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())) } }
  servers.push(handle)
  return handle
}

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: IncomingMessage['headers']
  readonly body: string
}

async function startUpstream(
  onRequest: (record: RecordedRequest, response: ServerResponse) => void,
): Promise<{ origin: string; recorded: RecordedRequest[] }> {
  const recorded: RecordedRequest[] = []
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const record: RecordedRequest = {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      recorded.push(record)
      onRequest(record, response)
    })
  })
  const port = await listen(server)
  trackServer(server)
  return { origin: `http://127.0.0.1:${port}`, recorded }
}

describe('RemotePassthroughProxy', () => {
  it('rewrites Host and Origin to the upstream so the browser-trust fence passes', async () => {
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    const proxy = new RemotePassthroughProxy({
      resolveUpstream: () => new URL(upstream.origin),
    })
    proxies.push(proxy)
    await proxy.start()

    const response = await fetch(proxy.origin() + '/api/ping', {
      headers: {
        origin: 'https://qiushenjiemacbookpro.taile854bf.ts.net',
        'sec-fetch-site': 'cross-site',
      },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(upstream.recorded).toHaveLength(1)
    const seen = upstream.recorded[0]!
    // The fence passes when the Host is loopback and Origin matches it.
    expect(seen.headers.host).toBe(new URL(upstream.origin).host)
    expect(seen.headers.origin).toBe(upstream.origin)
    expect(seen.headers['sec-fetch-site']).toBe('same-origin')
  })

  it('injects the upstream session cookie from the authenticated URL exchange', async () => {
    let exchanged = false
    const upstream = await startUpstream((record, response) => {
      if (record.path.startsWith('/?session=')) {
        exchanged = true
        response.writeHead(303, { 'set-cookie': 'dsh_session=abc123; Max-Age=3600; Path=/' })
        response.end()
        return
      }
      if (record.headers.cookie === 'dsh_session=abc123') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('authed')
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('guest')
    })
    const proxy = new RemotePassthroughProxy({
      resolveUpstream: () => new URL(upstream.origin),
      resolveAuthenticatedUrl: (origin) => origin.origin === upstream.origin ? `${upstream.origin}/?session=tok123` : undefined,
    })
    proxies.push(proxy)
    await proxy.start()

    const response = await fetch(proxy.origin() + '/api/session')
    expect(await response.text()).toBe('authed')
    expect(exchanged).toBe(true)
  })

  it('follows a live upstream change between requests', async () => {
    const upstreamA = await startUpstream((_record, response) => {
      response.writeHead(200)
      response.end('A')
    })
    const upstreamB = await startUpstream((_record, response) => {
      response.writeHead(200)
      response.end('B')
    })
    let current = new URL(upstreamA.origin)
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => current })
    proxies.push(proxy)
    await proxy.start()

    expect(await (await fetch(proxy.origin() + '/')).text()).toBe('A')
    current = new URL(upstreamB.origin)
    expect(await (await fetch(proxy.origin() + '/')).text()).toBe('B')
  })

  it('orders the mobile client before settings in the remote document', async () => {
    // DSH answers the document with Transfer-Encoding: chunked and no
    // Content-Length, so the rewrite must not be gated on a declared length.
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.write(bootDocument())
      response.end()
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const response = await fetch(proxy.origin() + '/')
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(upstream.recorded[0]?.headers['content-length']).toBeUndefined()
    expect(body).toContain('window.__DSH_MOBILE_TRUSTED_GATEWAY__=true')
    expect(body).toContain(`"inject":["@deepseek-ai/dsh-api-remotes","${packageName}"]`)
    // The remote channel keeps DSH's own layout.
    expect(body).toContain('"/plugins/layout.js"')
    // The document has to arrive uncompressed for the rewrite to apply.
    expect(upstream.recorded[0]?.headers['accept-encoding']).toBe('identity')
  })

  it('replaces the current-generation layout and serves that module itself when asked', async () => {
    // The layout module for the generation DSH 0.1.7 ships is served from this
    // proxy's own loopback listener: the request never reaches upstream, which
    // only knows its own layout bundle.
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.write(bootDocument().replace(
        '"inject":["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-session","@deepseek-ai/dsh-client-ui-theme"]',
        '"inject":["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-session","@deepseek-ai/dsh-client-ui-theme","@deepseek-ai/dsh-client-shortcuts"]',
      ))
      response.end()
    })
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-layout-'))
    const layoutFile = join(directory, 'mobile-layout-next.js')
    await writeFile(layoutFile, 'globalThis.__dedicatedMobileLayoutNext = true;\n', 'utf8')
    const proxy = new RemotePassthroughProxy({
      resolveUpstream: () => new URL(upstream.origin),
      mobileLayout: 'mobile',
      mobileLayoutNextFile: layoutFile,
    })
    proxies.push(proxy)
    await proxy.start()

    const document = await (await fetch(proxy.origin() + '/')).text()
    expect(document).toContain('"url":"/mobile-access/mobile-layout-next.js"')
    expect(document).toContain('"rev":"dsh-mobile-layout-next-')

    const module = await fetch(proxy.origin() + '/mobile-access/mobile-layout-next.js')
    expect(module.status).toBe(200)
    expect(module.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await module.text()).toBe('globalThis.__dedicatedMobileLayoutNext = true;\n')
    // Upstream never sees the layout request.
    expect(upstream.recorded.some(record => record.path.includes('mobile-layout-next'))).toBe(false)
  })

  it('serves a pruned boot batch itself instead of the stock combined request', async () => {
    // DSH asks for the whole graph in one combined request per phase and only
    // serves the exact combinations it built, so dropping the 5.3 MB account
    // module means this proxy has to assemble and serve that batch itself.
    const entries = [
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: 'plugins/??@deepseek-ai/dsh-client-ui-layout/client.js&rev=l',
        rev: 'l',
        inject: [
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-renderer',
          '@deepseek-ai/dsh-client-ui-session',
          '@deepseek-ai/dsh-client-ui-theme',
        ],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings-account',
        url: 'plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=a',
        rev: 'a',
        inject: ['@deepseek-ai/dsh-client-ui-settings'],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: 'plugins/??@deepseek-ai/dsh-client-ui-settings/client.js&rev=s',
        rev: 's',
        inject: ['@deepseek-ai/dsh-api-remotes'],
      },
      {
        id: packageName,
        url: 'plugins/??dsh-mobile-tailscale/client.js&rev=m',
        rev: 'm',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
      },
    ]
    const document = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: 'plugins/??application.js&rev=stock', rev: 'stock', entries: entries.map(entry => entry.id) }],
    })};</script></head><body>app</body></html>`
    const upstream = await startUpstream((record, response) => {
      if (record.path === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(document)
        return
      }
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(`/* module ${record.path} */`)
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const documentResponse = await fetch(proxy.origin() + '/')
    const html = await documentResponse.text()
    const batchPath = /"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/u.exec(html)?.[1]

    // The pruned module is gone from the manifest itself: entry and batch entry.
    expect(batchPath).toBeDefined()
    expect(html).not.toContain('settings-account')
    expect(html).not.toContain('plugins/??application.js&rev=stock')

    const batchResponse = await fetch(proxy.origin() + String(batchPath))
    const batch = await batchResponse.text()

    expect(batchResponse.status).toBe(200)
    expect(batchResponse.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(batch).toContain('@deepseek-ai/dsh-client-ui-layout/client.js')
    expect(batch).toContain('@deepseek-ai/dsh-client-ui-settings/client.js')
    expect(batch).toContain('dsh-mobile-tailscale/client.js')
    // The bytes never came from the stock combined request, and never included
    // the pruned module.
    expect(batch).not.toContain('settings-account')
    expect(upstream.recorded.some(record => record.path.includes('??application.js'))).toBe(false)

    const cached = await fetch(proxy.origin() + String(batchPath), {
      headers: { 'if-none-match': batchResponse.headers.get('etag') ?? '' },
    })
    expect(cached.status).toBe(304)
  })

  it('falls back to the stock combined request when a module cannot be fetched', async () => {
    // Pruning must never cost the page: if a module cannot be fetched, the
    // upstream's own combined request still serves the complete graph.
    const entries = [
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: 'plugins/??@deepseek-ai/dsh-client-ui-layout/client.js&rev=l',
        rev: 'l',
        inject: [
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-renderer',
          '@deepseek-ai/dsh-client-ui-session',
          '@deepseek-ai/dsh-client-ui-theme',
        ],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: 'plugins/??@deepseek-ai/dsh-client-ui-settings/client.js&rev=s',
        rev: 's',
        inject: ['@deepseek-ai/dsh-api-remotes'],
      },
    ]
    const document = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: 'plugins/??application.js&rev=stock', rev: 'stock', entries: entries.map(entry => entry.id) }],
    })};</script></head><body>app</body></html>`
    const upstream = await startUpstream((record, response) => {
      if (record.path === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(document)
        return
      }
      if (record.path.includes('??application.js')) {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        response.end('/* stock combined graph */')
        return
      }
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('nope')
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const html = await (await fetch(proxy.origin() + '/')).text()
    const batchPath = /"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/u.exec(html)?.[1]
    const batchResponse = await fetch(proxy.origin() + String(batchPath))

    expect(batchResponse.status).toBe(200)
    expect(await batchResponse.text()).toBe('/* stock combined graph */')
    expect(upstream.recorded.some(record => record.path.includes('??application.js'))).toBe(true)
  })

  it('passes a non-document response through untouched', async () => {
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('plain')
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    expect(await (await fetch(proxy.origin() + '/')).text()).toBe('plain')
  })

  it('caches a revisioned asset on the remote channel instead of stripping its freshness', async () => {
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag: '"asset"' })
      response.end('/* asset */')
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const revisioned = await fetch(proxy.origin() + '/plugins/@example/plugin/assets/mermaid.js?rev=ebebb4015a5c')
    expect(revisioned.status).toBe(200)
    expect(revisioned.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    const hashed = await fetch(proxy.origin() + '/assets/index-Q6zc2uHV.js')
    expect(hashed.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    const unversioned = await fetch(proxy.origin() + '/plugins/events')
    expect(unversioned.headers.get('cache-control')).toBeNull()
  })

  it('answers the health probe upstream does not serve', async () => {
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not_found"}')
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const health = await fetch(`${proxy.origin()}/mobile-access/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
    expect(health.headers.get('cache-control')).toBe('no-store')
    const posted = await fetch(`${proxy.origin()}/mobile-access/health`, { method: 'POST', body: '{}' })
    expect(posted.status).toBe(405)
  })

  it('trims the history page a tailnet client asks for', async () => {
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"records":[]}')
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const historyRequest = (payload: Record<string, unknown>): string => JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-example',
      method: 'session.history',
      payload: { sessionId: 'session-example', ...payload },
    })
    const post = (body: string): Promise<Response> => fetch(proxy.origin() + '/api/session.history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })

    // The stock browser client asks for 500 messages per page; a phone gets 50.
    const large = await post(historyRequest({ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }))
    expect(large.status).toBe(200)
    const forwarded = upstream.recorded.at(-1)
    expect(JSON.parse(forwarded?.body ?? '{}')).toMatchObject({
      method: 'session.history',
      payload: { sessionId: 'session-example', maxMessages: 50 },
    })
    expect(JSON.parse(forwarded?.body ?? '{}').payload.turnWindow).toBeUndefined()
    expect(forwarded?.headers['content-length']).toBe(String(Buffer.byteLength(forwarded?.body ?? '')))

    // A page the client already bounded stays untouched.
    await post(historyRequest({ maxMessages: 10 }))
    expect(JSON.parse(upstream.recorded.at(-1)?.body ?? '{}')).toMatchObject({ payload: { maxMessages: 10 } })

    // A Turn window wider than the page we ask for is dropped, not narrowed: the
    // floor is what lets `paginate` walk past the message count the phone asked
    // for (291 records for a 50-message window on a measured long session).
    await post(historyRequest({ maxMessages: 500, turnWindow: { minMessages: 200, minTurns: 2 } }))
    expect(JSON.parse(upstream.recorded.at(-1)?.body ?? '{}')).toMatchObject({
      payload: { maxMessages: 50 },
    })
    expect(JSON.parse(upstream.recorded.at(-1)?.body ?? '{}').payload.turnWindow).toBeUndefined()

    // Anything that is not a history request is forwarded byte for byte.
    const other = await fetch(proxy.origin() + '/api/session.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"type":"client-request"}',
    })
    expect(other.status).toBe(200)
    expect(upstream.recorded.at(-1)?.body).toBe('{"type":"client-request"}')
  })

  it('serves the stock document when the upstream contract is unsupported', async () => {
    const unsupported = '<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = {"rev":"x","entries":[]};</script></head><body>stock</body></html>'
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(unsupported)) })
      response.end(unsupported)
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    const response = await fetch(proxy.origin() + '/')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(unsupported)
  })

  it('forwards WebSocket upgrades to any path (plugin channels like /sidebar/ws/*)', async () => {
    const recordedPaths: string[] = []
    const upstreamServer = createHttpServer()
    upstreamServer.on('upgrade', (request, socket) => {
      recordedPaths.push(request.url ?? '')
      socket.end([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${websocketAccept(String(request.headers['sec-websocket-key']))}`,
        '',
        '',
      ].join('\r\n'))
    })
    const upstreamPort = await listen(upstreamServer)
    trackServer(upstreamServer)
    const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`

    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstreamOrigin) })
    proxies.push(proxy)
    await proxy.start()

    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    await new Promise<void>((resolve, reject) => {
      const proxyPort = Number(new URL(proxy.origin()).port)
      const client = requestHttp({
        host: '127.0.0.1',
        port: proxyPort,
        path: '/sidebar/ws/agent-opens?sessionId=abc',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': key,
          'sec-websocket-version': '13',
        },
      })
      client.once('upgrade', (_response, socket) => {
        socket.destroy()
        resolve()
      })
      client.once('error', reject)
      client.end()
    })
    expect(recordedPaths).toEqual(['/sidebar/ws/agent-opens?sessionId=abc'])
  })

  it('forwards WebSocket upgrades with a rewritten handshake', async () => {
    const recordedHost: string[] = []
    const recordedOrigin: string[] = []
    const upstreamServer = createHttpServer()
    upstreamServer.on('upgrade', (request, socket) => {
      recordedHost.push(String(request.headers.host ?? ''))
      recordedOrigin.push(String(request.headers.origin ?? ''))
      socket.end([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${websocketAccept(String(request.headers['sec-websocket-key']))}`,
        '',
        '',
      ].join('\r\n'))
    })
    const upstreamPort = await listen(upstreamServer)
    trackServer(upstreamServer)
    const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`

    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstreamOrigin) })
    proxies.push(proxy)
    await proxy.start()

    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    await new Promise<void>((resolve, reject) => {
      const proxyPort = Number(new URL(proxy.origin()).port)
      const client = requestHttp({
        host: '127.0.0.1',
        port: proxyPort,
        path: '/api/events.mux',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': key,
          'sec-websocket-version': '13',
          origin: 'https://qiushenjiemacbookpro.taile854bf.ts.net',
        },
      })
      client.once('upgrade', (_response, socket) => {
        socket.destroy()
        resolve()
      })
      client.once('error', reject)
      client.end()
    })
    expect(recordedHost).toEqual([new URL(upstreamOrigin).host])
    expect(recordedOrigin).toEqual([upstreamOrigin])
  })

  it('refuses the loopback-only admin surface instead of forwarding it', async () => {
    // Verified against a live deployment before this guard existed: a plain
    // curl to POST /api/mobile-access/lan/pairing/open on the tailnet origin
    // answered 201 with a pairing token, and GET .../lan/status answered 200,
    // because the proxy makes tailnet requests arrive at the upstream looking
    // loopback-local and assertLocalAdminTrust keys off exactly that.
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"token":"must-never-be-reachable"}')
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    proxies.push(proxy)
    await proxy.start()

    for (const path of [
      '/api/mobile-access/lan/pairing/open',
      '/api/mobile-access/lan/status',
      '/api/mobile-access/lan/devices/revoke',
      '/api/mobile-access/lan/devices/reset',
      '/api/mobile-access/remote/control',
      '/api/mobile-access',
    ]) {
      const response = await fetch(proxy.origin() + path, { method: 'POST' })
      expect(response.status, path).toBe(404)
      expect(await response.json(), path).toEqual({ error: 'not_found' })
    }
    // The guard runs before the forward, so nothing reached the upstream.
    expect(upstream.recorded).toHaveLength(0)

    // A neighbouring path that merely shares the prefix stays reachable.
    const neighbour = await fetch(proxy.origin() + '/api/mobile-accessibility')
    expect(neighbour.status).toBe(200)
    expect(upstream.recorded).toHaveLength(1)
  })

  it('answers a directly requested pruned module without fetching its bytes', async () => {
    const upstream = await startUpstream((_record, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end('window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-conversation", factory: () => ({}) });')
    })
    const proxy = new RemotePassthroughProxy({ resolveUpstream: () => new URL(upstream.origin) })
    await proxy.start()
    try {
      // The module controller asks for the stock spelling once it has synced to a
      // graph pushed over the HMR event stream, which lists the pruned module.
      const pruned = await fetch(
        proxy.origin() + '/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=15a7f5ec2ebc',
      )
      expect(pruned.status).toBe(200)
      expect(pruned.headers.get('content-type')).toContain('text/javascript')
      expect(await pruned.text()).toBe(
        'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-settings-account", factory: () => ({}) });\n',
      )
      expect(upstream.recorded).toHaveLength(0)

      // A module the phone is meant to run still comes from the upstream, so the
      // rewrite cannot swallow a legitimate single-module request.
      const stock = await fetch(
        proxy.origin() + '/plugins/??@deepseek-ai/dsh-client-ui-conversation/client.js&rev=abc123',
      )
      expect(stock.status).toBe(200)
      expect(upstream.recorded).toHaveLength(1)
    } finally {
      await proxy.close()
    }
  })
})

describe('resolveLiveUpstream', () => {
  it('prefers a valid live origin, then DSH_WEB_URL, then the fallback', () => {
    vi.stubEnv('DSH_WEB_URL', 'http://127.0.0.1:51999')
    expect(resolveLiveUpstream('http://127.0.0.1:3080', 'http://127.0.0.1:52001').origin).toBe('http://127.0.0.1:52001')
    expect(resolveLiveUpstream('http://127.0.0.1:3080').origin).toBe('http://127.0.0.1:51999')

    vi.stubEnv('DSH_WEB_URL', 'https://evil.example/')
    expect(resolveLiveUpstream('http://127.0.0.1:3080', 'http://127.0.0.1:52002').origin).toBe('http://127.0.0.1:52002')
    expect(resolveLiveUpstream('http://127.0.0.1:3080').origin).toBe('http://127.0.0.1:3080')

    vi.stubEnv('DSH_WEB_URL', '')
    expect(resolveLiveUpstream('http://127.0.0.1:3080', 'not-an-origin').origin).toBe('http://127.0.0.1:3080')
  })
})
