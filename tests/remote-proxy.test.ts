import { once } from 'node:events'
import {
  createServer as createHttpServer,
  request as requestHttp,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemotePassthroughProxy } from '../src/remote-proxy.js'
import { websocketAccept } from '../src/gateway.js'
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
}

async function startUpstream(
  onRequest: (record: RecordedRequest, response: ServerResponse) => void,
): Promise<{ origin: string; recorded: RecordedRequest[] }> {
  const recorded: RecordedRequest[] = []
  const server = createHttpServer((request, response) => {
    const record: RecordedRequest = {
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
    }
    recorded.push(record)
    onRequest(record, response)
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
