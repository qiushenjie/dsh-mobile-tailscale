import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { createServer, request as requestHttp } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { apply, inject } from '../src/plugin.js'
import { DSH_MOBILE_VERSION } from '../src/version.js'

const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => {
    // A real Tailscale node may own the 443 serve entry on this machine; the
    // controller's own teardown must not fail the suite because of it.
    await context.fiber.dispose().catch(() => undefined)
  }))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

interface InvokeOptions {
  readonly body?: string
  readonly contentType?: string | null
}

async function invoke(
  route: WebRoute,
  method: 'GET' | 'POST',
  path: string,
  options: InvokeOptions = {},
): Promise<{ status: number; body: string }> {
  const body = options.body ?? ''
  const server = createServer((request, response) => { void route.handler(request, response) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  try {
    return await new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = { host: `127.0.0.1:${String(port)}` }
      if (method === 'POST') {
        headers.origin = `http://127.0.0.1:${String(port)}`
        headers['sec-fetch-site'] = 'same-origin'
        const contentType = options.contentType === undefined ? 'application/json' : options.contentType
        if (contentType !== null) headers['content-type'] = contentType
        headers['content-length'] = Buffer.byteLength(body)
      }
      const request = requestHttp({ host: '127.0.0.1', port, method, path, headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      request.once('error', reject)
      if (body !== '') request.write(body)
      request.end()
    })
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }
}

interface Mounted {
  readonly context: Context
  readonly adminRoute: WebRoute
  readonly assetRoute: WebRoute
  readonly command: CommandDefinition
}

async function mount(): Promise<Mounted> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-plugin-'))
  temporaryDirectories.push(directory)
  const routes: WebRoute[] = []
  let command: CommandDefinition | undefined
  const context = new Context()
  contexts.push(context)
  context.provide('webServer', {
    register(candidate: WebRoute) {
      routes.push(candidate)
      return () => {
        const index = routes.indexOf(candidate)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  } as WebServer)
  context.provide('commands', {
    register(definition: CommandDefinition) {
      command = definition
      return () => { if (command === definition) command = undefined }
    },
  } as never)
  context.provide('connection', {
    authenticatedUrl(baseUrl: string) {
      return `${baseUrl}/?token=test-launch-token`
    },
  } as never)
  await context.plugin({ Config, inject, apply }, {
    stateFile: join(directory, 'mobile-access.json'),
    customCssFile: join(directory, 'mobile.css'),
    customScriptFile: join(directory, 'mobile.js'),
  })
  const adminRoute = routes.find(candidate => candidate.kind === 'prefix' && candidate.path === '/api/mobile-access')
  if (adminRoute === undefined) throw new Error('plugin did not register its control route')
  const assetRoute = routes.find(candidate => candidate.kind === 'prefix' && candidate.path === '/mobile-access')
  if (assetRoute === undefined) throw new Error('plugin did not register its phone asset route')
  if (command === undefined) throw new Error('plugin did not register its /mobile command')
  return { context, adminRoute, assetRoute, command }
}

describe('remote-channel plugin lifecycle', () => {
  it('requires the WebServer, commands, and Connection services', () => {
    expect(inject).toEqual(['webServer', 'commands', 'connection'])
  })

  it('keeps the loopback admin route available while remote access is stopped', async () => {
    const mounted = await mount()
    expect(mounted.adminRoute).toMatchObject({ kind: 'prefix', path: '/api/mobile-access' })

    const remote = await invoke(mounted.adminRoute, 'GET', '/api/mobile-access/remote/control')
    expect(remote.status).toBe(200)
    expect(JSON.parse(remote.body)).toEqual({ provider: 'tailscale', running: false, state: 'off' })

    // Disabling an already-disabled remote is a local no-op: it must not run
    // the Tailscale CLI or touch the machine's serve configuration.
    const stopped = await invoke(mounted.adminRoute, 'POST', '/api/mobile-access/remote/control', {
      body: JSON.stringify({ running: false }),
    })
    expect(stopped.status).toBe(200)
    expect(JSON.parse(stopped.body)).toEqual({ provider: 'tailscale', running: false, state: 'off' })

    const diagnostics = await invoke(mounted.adminRoute, 'GET', '/api/mobile-access/diagnostics')
    expect(diagnostics.status).toBe(200)
    const payload = JSON.parse(diagnostics.body) as {
      versions: Record<string, string>
      checks: { id: string }[]
    }
    expect(payload).toMatchObject({
      version: 1,
      overall: 'ok',
      versions: { plugin: DSH_MOBILE_VERSION, dsh: expect.any(String) },
      report: expect.stringContaining('DSH Mobile 诊断报告'),
    })
    expect(payload.versions).not.toHaveProperty('minimumAndroidApp')
    expect(payload.checks.map(entry => entry.id)).toEqual(['versions', 'remote', 'phone-network'])
  })

  it('rejects malformed admin requests without reaching the remote provider', async () => {
    const mounted = await mount()

    const badRunning = await invoke(mounted.adminRoute, 'POST', '/api/mobile-access/remote/control', {
      body: JSON.stringify({ running: 'yes' }),
    })
    expect(badRunning.status).toBe(400)
    expect(JSON.parse(badRunning.body)).toEqual({ error: 'bad_request' })

    const missingRunning = await invoke(mounted.adminRoute, 'POST', '/api/mobile-access/remote/control', {
      body: JSON.stringify({}),
    })
    expect(missingRunning.status).toBe(400)

    const wrongType = await invoke(mounted.adminRoute, 'POST', '/api/mobile-access/remote/control', {
      body: '{}',
      contentType: 'text/plain',
    })
    expect(wrongType.status).toBe(415)
    expect(JSON.parse(wrongType.body)).toEqual({ error: 'unsupported_media_type' })

    const unconfirmedReset = await invoke(mounted.adminRoute, 'POST', '/api/mobile-access/remote/reset', {
      body: JSON.stringify({}),
    })
    expect(unconfirmedReset.status).toBe(400)

    const unknown = await invoke(mounted.adminRoute, 'GET', '/api/mobile-access/nope')
    expect(unknown.status).toBe(404)
    expect(JSON.parse(unknown.body)).toEqual({ error: 'not_found' })

    const queried = await invoke(mounted.adminRoute, 'GET', '/api/mobile-access/remote/control?x=1')
    expect(queried.status).toBe(400)
    expect(JSON.parse(queried.body)).toEqual({ error: 'bad_request' })

    const wrongMethod = await invoke(mounted.adminRoute, 'POST', '/api/mobile-access/diagnostics', {
      body: '{}',
    })
    expect(wrongMethod.status).toBe(404)
  })

  it('serves the phone asset surface from the same plugin activation', async () => {
    const mounted = await mount()
    expect(mounted.assetRoute).toMatchObject({ kind: 'prefix', path: '/mobile-access' })

    const metadata = await invoke(mounted.assetRoute, 'GET', '/mobile-access/metadata')
    expect(metadata.status).toBe(200)
    expect(JSON.parse(metadata.body)).toEqual({ version: 1, pluginVersion: DSH_MOBILE_VERSION })

    const css = await invoke(mounted.assetRoute, 'GET', '/mobile-access/custom.css')
    expect(css.status).toBe(200)
    expect(css.body).toContain('mobile-access/mobile.css')

    const missingLayout = await invoke(mounted.assetRoute, 'GET', '/mobile-access/mobile-layout.js')
    expect(missingLayout.status).toBe(503)
    expect(JSON.parse(missingLayout.body)).toEqual({ error: 'mobile_frontend_unavailable' })
  })

  it('registers a /mobile command that steers the agent with the customization guide', async () => {
    const mounted = await mount()
    expect(mounted.command).toMatchObject({
      name: 'mobile',
      description: expect.any(String),
      input: { hint: expect.any(String) },
    })
    const steered: { text: string; source: unknown }[] = []
    const agent = {
      steer: (message: { content: readonly { readonly text?: string }[]; source: unknown }) => {
        steered.push({ text: message.content[0]?.text ?? '', source: message.source })
      },
      whenIdle: async (): Promise<void> => undefined,
    }
    const invokeCommand = (rawInput: string) => mounted.command.handler({
      agent,
      commandId: 'id' as never,
      signal: new AbortController().signal,
      rawInput,
    } as never)
    const empty = invokeCommand('  ')
    expect(empty).toMatchObject({ kind: 'error' })
    expect(steered).toEqual([])
    const result = invokeCommand('make the phone UI dark')
    expect(result).toMatchObject({ kind: 'success' })
    expect(steered.length).toBe(1)
    const [steeredMessage] = steered
    expect(steeredMessage).toBeDefined()
    expect(steeredMessage!.text).toContain('mobile-access')
    expect(steeredMessage!.text).toContain('make the phone UI dark')
    // The guide rides as a plugin-source context injection, not a user bubble.
    expect(steeredMessage!.source).toMatchObject({
      kind: 'plugin',
      plugin: 'dsh-mobile-tailscale',
      form: 'notice',
    })
  })
})
