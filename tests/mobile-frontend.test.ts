import { createServer, request as requestHttp } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MobileAssetRoute,
  mobileBootBatchKey,
  mobileHistoryRequestBody,
  prunedClientModuleRequest,
} from '../src/mobile-frontend.js'
import { DSH_MOBILE_VERSION } from '../src/version.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

interface Response {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
  readonly rawBody: Buffer
}

async function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const body = options.body
    const headers = { ...options.headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) }
    const outgoing = requestHttp({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => {
        const rawBody = Buffer.concat(chunks)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: rawBody.toString('utf8'), rawBody })
      })
    })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}

interface Mounted {
  readonly port: number
  readonly directory: string
  readonly customCssFile: string
  readonly customScriptFile: string
  readonly mobileLayoutFile: string
  readonly mobileLayoutNextFile: string
}

interface MountOptions {
  readonly css?: string
  readonly script?: string
  readonly layout?: string
  readonly layoutNext?: string
}

async function mount(options: MountOptions = {}): Promise<Mounted> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frontend-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const customCssFile = join(directory, 'mobile.css')
  const customScriptFile = join(directory, 'mobile.js')
  const mobileLayoutFile = join(directory, 'mobile-layout.js')
  const mobileLayoutNextFile = join(directory, 'mobile-layout-next.js')
  if (options.css !== undefined) await writeFile(customCssFile, options.css, 'utf8')
  if (options.script !== undefined) await writeFile(customScriptFile, options.script, 'utf8')
  if (options.layout !== undefined) await writeFile(mobileLayoutFile, options.layout, 'utf8')
  if (options.layoutNext !== undefined) await writeFile(mobileLayoutNextFile, options.layoutNext, 'utf8')
  const asset = new MobileAssetRoute({ customCssFile, customScriptFile, mobileLayoutFile, mobileLayoutNextFile, maxBodyBytes: 1024 * 1024 })
  const server = createServer((incoming, response) => { void asset.route().handler(incoming, response) })
  const port = await listen(server)
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { port, directory, customCssFile, customScriptFile, mobileLayoutFile, mobileLayoutNextFile }
}

describe('mobile asset route', () => {
  it('reports the phone metadata version', async () => {
    const { port } = await mount()
    const response = await request(port, '/mobile-access/metadata')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ version: 1, pluginVersion: DSH_MOBILE_VERSION })
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('serves the user stylesheet and script with a content hash', async () => {
    const { port } = await mount({ css: ':root { --preview: first; }\n', script: 'window.dshMobile.register(() => undefined)\n' })

    const first = await request(port, '/mobile-access/custom.css')
    expect(first.status).toBe(200)
    expect(first.headers['cache-control']).toBe('no-store')
    expect(first.headers.etag).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.headers['last-modified']).toBeDefined()
    expect(first.body).toContain('--preview: first')

    const cached = await request(port, '/mobile-access/custom.css', { headers: { 'if-none-match': String(first.headers.etag) } })
    expect(cached.status).toBe(304)
    expect(cached.body).toBe('')

    const script = await request(port, '/mobile-access/custom.js')
    expect(script.status).toBe(200)
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(script.body).toContain('dshMobile.register')
  })

  it('falls back to the documented defaults when the user files do not exist', async () => {
    const { port } = await mount()
    const css = await request(port, '/mobile-access/custom.css')
    expect(css.status).toBe(200)
    expect(css.body).toContain('mobile-access/mobile.css')
    const script = await request(port, '/mobile-access/custom.js')
    expect(script.status).toBe(200)
    expect(script.body).toContain('dshMobile')
  })

  it('reloads edited assets instead of caching the previous revision', async () => {
    const { port, customCssFile } = await mount({ css: ':root { --preview: first; }\n' })
    const first = await request(port, '/mobile-access/custom.css')
    expect(first.status).toBe(200)
    await writeFile(customCssFile, ':root { --preview: second; }\n', 'utf8')
    const second = await request(port, '/mobile-access/custom.css')
    expect(second.status).toBe(200)
    expect(second.body).toContain('--preview: second')
    expect(second.headers.etag).not.toBe(first.headers.etag)
  })

  it('serves the dedicated layout bundles when they are present', async () => {
    const { port } = await mount({
      layout: 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-layout" })\n',
      layoutNext: 'globalThis.__dedicatedMobileLayoutNext = true;\n',
    })
    const layout = await request(port, '/mobile-access/mobile-layout.js')
    expect(layout.status).toBe(200)
    expect(layout.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(layout.body).toContain('@deepseek-ai/dsh-client-ui-layout')

    const next = await request(port, '/mobile-access/mobile-layout-next.js')
    expect(next.status).toBe(200)
    expect(next.body).toContain('__dedicatedMobileLayoutNext')
  })

  it('fails closed when a dedicated layout bundle is missing', async () => {
    const { port } = await mount()
    for (const path of ['/mobile-access/mobile-layout.js', '/mobile-access/mobile-layout-next.js']) {
      const response = await request(port, path)
      expect(response.status).toBe(503)
      expect(JSON.parse(response.body)).toEqual({ error: 'mobile_frontend_unavailable' })
    }
  })

  it('answers unknown paths and non-GET requests with an error', async () => {
    const { port } = await mount({ css: ':root { --preview: first; }\n' })
    const unknown = await request(port, '/mobile-access/does-not-exist')
    expect(unknown.status).toBe(404)
    expect(JSON.parse(unknown.body)).toEqual({ error: 'not_found' })
    const posted = await request(port, '/mobile-access/custom.css', { method: 'POST', body: 'x' })
    expect(posted.status).toBe(404)
  })
})

describe('mobileHistoryRequestBody', () => {
  const frame = (value: unknown): Buffer => Buffer.from(JSON.stringify(value))

  it('clamps a flat session.history window and drops the Turn floor', () => {
    const body = frame({
      type: 'client-request',
      rpcId: 'rpc',
      method: 'session.history',
      payload: { sessionId: 'session-example', maxMessages: 500, turnWindow: { minMessages: 200, minTurns: 2 } },
    })
    const rewritten = JSON.parse(mobileHistoryRequestBody(
      { url: '/api/session.history', method: 'POST' } as IncomingMessage,
      body,
    ).toString('utf8')) as { payload: { sessionId: string; maxMessages: number; turnWindow?: unknown } }
    expect(rewritten.payload.sessionId).toBe('session-example')
    expect(rewritten.payload.maxMessages).toBe(10)
    expect(rewritten.payload.turnWindow).toBeUndefined()
  })

  it('keeps a window that already fits the phone page', () => {
    const body = frame({ method: 'session.history', payload: { sessionId: 'session-example', maxMessages: 5 } })
    const result = mobileHistoryRequestBody({ url: '/api/session.history', method: 'POST' } as IncomingMessage, body)
    expect(result).toBe(body)
  })

  it('clamps the nested DSH 0.1.7 session.page window', () => {
    const body = frame({
      method: 'session/page',
      payload: {
        args: {
          request: {
            address: { kind: 'session', sessionId: 'session-example' },
            throughSeq: 4096,
            maxMessages: 500,
            turnWindow: { minMessages: 200, minTurns: 2 },
          },
        },
      },
    })
    const rewritten = JSON.parse(mobileHistoryRequestBody(
      { url: '/api/session.page', method: 'POST' } as IncomingMessage,
      body,
    ).toString('utf8')) as { payload: { args: { request: { address: unknown; throughSeq: number; maxMessages: number; turnWindow?: unknown } } } }
    expect(rewritten.payload.args.request).toMatchObject({
      address: { kind: 'session', sessionId: 'session-example' },
      throughSeq: 4096,
      maxMessages: 10,
    })
    expect(rewritten.payload.args.request.turnWindow).toBeUndefined()
  })

  it('honours a caller-supplied phone page size', () => {
    const body = frame({ method: 'session.history', payload: { maxMessages: 500 } })
    const rewritten = JSON.parse(mobileHistoryRequestBody(
      { url: '/api/session.history', method: 'POST' } as IncomingMessage,
      body,
      20,
    ).toString('utf8')) as { payload: { maxMessages: number } }
    expect(rewritten.payload.maxMessages).toBe(20)
  })

  it('leaves other methods, paths, and unparseable bodies untouched', () => {
    const body = frame({ method: 'session.history', payload: { maxMessages: 500 } })
    expect(mobileHistoryRequestBody({ url: '/api/session.history', method: 'GET' } as IncomingMessage, body)).toBe(body)
    expect(mobileHistoryRequestBody({ url: '/api/session.other', method: 'POST' } as IncomingMessage, body)).toBe(body)
    const notJson = Buffer.from('not json')
    expect(mobileHistoryRequestBody({ url: '/api/session.history', method: 'POST' } as IncomingMessage, notJson)).toBe(notJson)
    const noPayload = frame({ method: 'session.history' })
    expect(mobileHistoryRequestBody({ url: '/api/session.history', method: 'POST' } as IncomingMessage, noPayload)).toBe(noPayload)
  })
})

describe('mobileBootBatchKey', () => {
  it('recognises a 64-hex boot batch path and nothing else', () => {
    const key = 'a'.repeat(64)
    expect(mobileBootBatchKey(`/mobile-access/mobile-boot/${key}.js`)).toBe(key)
    expect(mobileBootBatchKey(`/mobile-access/mobile-boot/${'a'.repeat(63)}.js`)).toBeUndefined()
    expect(mobileBootBatchKey('/mobile-access/mobile-boot/not-a-key.js')).toBeUndefined()
    expect(mobileBootBatchKey('/mobile-access/custom.css')).toBeUndefined()
  })
})

describe('prunedClientModuleRequest', () => {
  it('recognises the single-module spelling of a pruned module', () => {
    expect(prunedClientModuleRequest(
      '/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=15a7f5ec2ebc',
    )).toBe('@deepseek-ai/dsh-client-ui-settings-account')
    expect(prunedClientModuleRequest(
      '/plugins/@deepseek-ai/dsh-client-ui-settings-account/client.js?rev=15a7f5ec2ebc',
    )).toBe('@deepseek-ai/dsh-client-ui-settings-account')
  })

  it('leaves stock phase requests, other modules and other paths alone', () => {
    // A phase request names many ids and is answered by the upstream's own
    // combination, so it must never be rewritten here.
    expect(prunedClientModuleRequest(
      '/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js,dsh-mobile-tailscale/client.js&rev=abc',
    )).toBeUndefined()
    expect(prunedClientModuleRequest('/plugins/??dsh-mobile-tailscale/client.js&rev=abc')).toBeUndefined()
    expect(prunedClientModuleRequest(
      '/plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/logo.svg?rev=abc',
    )).toBeUndefined()
    expect(prunedClientModuleRequest('/assets/index-Q6zc2uHV.js')).toBeUndefined()
    expect(prunedClientModuleRequest(undefined)).toBeUndefined()
  })
})
