import { Context } from '@deepseek-ai/cordis'
import { createServer, request as requestHttp } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MobileAccessService } from '../src/extensions.js'
import { MobileAssetRoute } from '../src/mobile-frontend.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body
    const headers = { ...options.headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) }
    const outgoing = requestHttp({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject); outgoing.end(body)
  })
}

async function mount(): Promise<{ directory: string; port: number }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-gateway-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const context = new Context()
  cleanups.push(() => context.fiber.dispose().catch(() => undefined))
  const service = new MobileAccessService(context)
  service.registerExtension({
    schemaVersion: 1, id: 'hello', name: 'Hello', version: '1.0.0',
    actions: { echo: { run: async (_context, input) => ({ input }) } },
    routes: [{ method: 'GET', path: 'status', handle: async () => ({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }) }],
  })
  const route = new MobileAssetRoute({
    customCssFile: join(directory, 'mobile.css'),
    customScriptFile: join(directory, 'mobile.js'),
    mobileLayoutFile: join(directory, 'mobile-layout.js'),
    mobileLayoutNextFile: join(directory, 'mobile-layout-next.js'),
    maxBodyBytes: 1024 * 1024,
    extensions: service,
  })
  const server = createServer((incoming, response) => { void route.route().handler(incoming, response) })
  const port = await listen(server)
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { directory, port }
}

describe('mobile asset route extension namespace', () => {
  it('serves extension actions and routes straight from the asset route', async () => {
    const { port } = await mount()
    // The remote channel reaches this route over Tailscale Serve, so the
    // extension namespace is invoked without any pairing or cookie dance.
    const action = await request(port, '/mobile-access/extensions/hello/actions/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 1 }),
    })
    expect(action.status).toBe(200)
    expect(JSON.parse(action.body)).toEqual({ input: { value: 1 } })

    const route = await request(port, '/mobile-access/extensions/hello/routes/status')
    expect(route.status).toBe(200)
    expect(JSON.parse(route.body)).toEqual({ ok: true })

    const unknownAction = await request(port, '/mobile-access/extensions/hello/actions/missing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(unknownAction.status).toBeGreaterThanOrEqual(400)
    expect(JSON.parse(unknownAction.body)).toHaveProperty('error')
  })

  it('serves the extension manifest on the canonical path the client requests', async () => {
    const { directory, port } = await mount()
    const manifest = await request(port, '/mobile-access/extensions/manifest')
    expect(manifest.status).toBe(200)
    expect(JSON.parse(manifest.body)).toMatchObject({
      protocol: 1,
      extensions: [{ id: 'hello' }],
      legacy: { scriptRevision: expect.any(String), styleRevision: expect.any(String) },
    })
    expect(manifest.headers.etag).toBeTruthy()
    const notModified = await request(port, '/mobile-access/extensions/manifest', { headers: { 'if-none-match': String(manifest.headers.etag) } })
    expect(notModified.status).toBe(304)
    await writeFile(join(directory, 'mobile.js'), 'window.dshMobile?.register(() => undefined)\n// changed\n')
    const customized = await request(port, '/mobile-access/extensions/manifest', { headers: { 'if-none-match': String(manifest.headers.etag) } })
    expect(customized.status).toBe(200)
    expect(JSON.parse(customized.body)).not.toMatchObject({ legacy: (JSON.parse(manifest.body) as { legacy: unknown }).legacy })
  })
})
