import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
// Side-effect type import: activates dsh-commands' Context augmentation so
// `ctx.commands` and its handler types resolve without a runtime dependency.
import type {} from '@deepseek-ai/dsh-commands'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseMobileConfig, type PluginConfig } from './config.js'
import { warnUnsupportedDshVersion } from './compatibility.js'
import { collectConnectionDiagnostics } from './diagnostics.js'
import { MOBILE_CUSTOMIZATION_GUIDE } from './mobile-guide.js'
import { JsonMobileAccessControlStore } from './control.js'
import { MobileAssetRoute } from './mobile-frontend.js'
import { createMobileAccessService, type MobileAccessService } from './extensions.js'
import {
  AUTH_PREFIX,
  HttpError,
  LOCAL_ADMIN_PREFIX,
  assertLocalAdminTrust,
  parseRequestTarget,
  readJsonObject,
  sendFailure,
  sendJson,
} from './http-security.js'
import { configuredRemoteProvider, JsonRemoteProviderStore, type RemoteProvider } from './remote.js'
import { TailscaleServeController } from './tailscale-serve.js'
import { RemotePassthroughProxy } from './remote-proxy.js'
import { resolveLiveUpstream } from './upstream.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-mobile-tailscale'

/** The stock WebServer serves the control card; Connection authenticates the loopback DSH origin. */
export const inject = ['webServer', 'commands', 'connection']

interface BrowserAuthenticatedConnection {
  authenticatedUrl?: (baseUrl: string) => string
}

function upstreamAuthenticatedUrl(ctx: Context, upstreamOrigin: URL): string | undefined {
  const connection = (ctx as Context & { readonly connection?: BrowserAuthenticatedConnection }).connection
  return typeof connection?.authenticatedUrl === 'function'
    ? connection.authenticatedUrl(upstreamOrigin.origin)
    : undefined
}

/** The authoritative live loopback origin of this process's web server, when bound to loopback. */
function webServerOrigin(ctx: Context): string | undefined {
  const server = (ctx as Context & { readonly webServer?: { readonly host?: unknown; readonly port?: unknown } }).webServer
  if (server?.host !== '127.0.0.1') return undefined
  const port = server.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return `http://127.0.0.1:${port}`
}

function installedDshVersion(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url)('@deepseek-ai/dsh-host-webserver/package.json') as unknown
    if (manifest === null || typeof manifest !== 'object') return undefined
    const version = (manifest as { readonly version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    // The desktop app bundles the Host WebServer inside its archive, so it
    // may not resolve from this profile; an unknown version must not block boot.
    return undefined
  }
}

interface RemoteStatus {
  readonly enabled: boolean
  readonly state: string
  readonly origin?: string
  readonly loginUrl?: string
  readonly setupUrl?: string
  readonly errorCode?: string
}

function remoteControlPayload(
  provider: RemoteProvider,
  status: RemoteStatus,
): Record<string, unknown> {
  return {
    provider,
    running: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.loginUrl === undefined ? {} : { loginUrl: status.loginUrl }),
    ...(status.setupUrl === undefined ? {} : { setupUrl: status.setupUrl }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  }
}

/**
 * Mount the resident control route and the Tailscale Serve remote channel.
 *
 * There is deliberately no LAN listener: the phone reaches the loopback DSH web
 * server only through `tailscale serve`, so tailnet membership is the whole
 * access control and no pairing secret or self-signed CA exists to trust.
 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const dshVersion = installedDshVersion() ?? 'unknown'
  // Advisory only: an unverified Host version must never abort activation, or
  // the failed loader entry takes the whole plugin tree — and therefore the
  // Host boot — down with it (DSH Desktop then falls back to its safe-mode
  // profile with every third-party plugin disabled).
  warnUnsupportedDshVersion(dshVersion)
  const resolved = parseMobileConfig(config)
  const mobileAccess: MobileAccessService = createMobileAccessService(ctx)
  const liveWebOrigin = webServerOrigin(ctx)
  const resolveUpstream = (): URL => resolveLiveUpstream(resolved.upstreamOrigin.origin, liveWebOrigin)
  const resolveAuthenticatedUrl = (upstream: URL): string | undefined => upstreamAuthenticatedUrl(ctx, upstream)
  const remoteDirectory = join(resolved.stateDirectory, 'remote')
  const remoteProviderStore = new JsonRemoteProviderStore(
    join(remoteDirectory, 'provider.json'),
    configuredRemoteProvider(process.env),
  )
  const remoteProvider = (await remoteProviderStore.load()).provider
  const assetRoute = new MobileAssetRoute({
    customCssFile: resolved.customCssFile,
    customScriptFile: resolved.customScriptFile,
    mobileLayoutFile: resolved.mobileLayoutFile,
    mobileLayoutNextFile: resolved.mobileLayoutNextFile,
    maxBodyBytes: resolved.maxBodyBytes,
    extensions: mobileAccess,
  })
  const tailscaleStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'control.json'), false)
  const remoteProxy = new RemotePassthroughProxy({
    resolveUpstream,
    resolveAuthenticatedUrl,
    upstreamTimeoutMs: resolved.upstreamTimeoutMs,
    maxBodyBytes: resolved.maxBodyBytes,
    maxWebSockets: resolved.maxWebSockets,
    mobileLayoutNextFile: resolved.mobileLayoutNextFile,
    mobileLayout: resolved.mobileLayout,
  })
  const remoteControllers = {
    tailscale: new TailscaleServeController({
      store: tailscaleStore,
      proxy: remoteProxy,
    }),
  }
  const remoteController = () => remoteControllers[remoteProvider]
  const remotePayload = (): Record<string, unknown> => remoteControlPayload(
    remoteProvider,
    remoteController().status(),
  )
  const diagnosticsPayload = async (): Promise<Record<string, unknown>> => {
    const remote = remoteController().status()
    return collectConnectionDiagnostics({
      dshVersion,
      remote: {
        provider: remoteProvider,
        running: remote.enabled,
        state: remote.state,
        ...(remote.origin === undefined ? {} : { origin: remote.origin }),
        ...(remote.errorCode === undefined ? {} : { errorCode: remote.errorCode }),
      },
    }) as unknown as Record<string, unknown>
  }

  const adminRoute: WebRoute = {
    kind: 'prefix',
    path: LOCAL_ADMIN_PREFIX,
    handler: async (request, response) => {
      try {
        const target = parseRequestTarget(request.url)
        assertLocalAdminTrust(request, request.method === 'POST')
        if (target.search !== '') throw new HttpError(400, 'bad_request')
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/diagnostics`) {
          sendJson(response, 200, await diagnosticsPayload(), false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/control`) {
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/control`) {
          const body = await readJsonObject(request, 4096)
          if (typeof body.running !== 'boolean') throw new HttpError(400, 'bad_request')
          await remoteController().setEnabled(body.running)
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/reconnect`) {
          await readJsonObject(request, 4096)
          await remoteController().reconnect()
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/reset`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await remoteController().reset()
          sendJson(response, 200, remotePayload(), false)
          return
        }
        throw new HttpError(404, 'not_found')
      } catch (error) {
        const mapped = error instanceof HttpError ? error : new HttpError(500, 'internal_error')
        if (response.headersSent) response.destroy()
        else sendFailure(response, mapped.status, mapped.code, false)
      }
    },
  }

  // Custom phone assets (stylesheet, custom script, dedicated layout bundle,
  // extensions) for the remote channel: the phone reaches them through the
  // passthrough proxy as `${AUTH_PREFIX}/**` on the loopback DSH web server,
  // where tailnet membership is the access control.
  const mobileFrontendRoute: WebRoute = assetRoute.route()

  await ctx.effect(async () => {
    const unregister = ctx.webServer.register(adminRoute)
    const unregisterFrontend = ctx.webServer.register(mobileFrontendRoute)
    const disposeMobileCommand = ctx.commands.register({
      name: 'mobile',
      description: '按需求修改 DSH Mobile 的手机端界面或添加电脑端能力',
      input: { hint: '<要做什么>' },
      handler: ({ agent, rawInput }) => {
        const task = rawInput.trim()
        if (task === '') return { kind: 'error', text: '请带上需求，例如：/mobile 把手机端改成深色主题' }
        // A plugin-source message renders as a collapsed context-injection row
        // (label "dsh-mobile", one-line notice summary) instead of a user bubble,
        // while steering still wakes the agent with the full guide as input.
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `${MOBILE_CUSTOMIZATION_GUIDE}\n\n用户需求：${task}` }],
          source: {
            kind: 'plugin',
            plugin: 'dsh-mobile-tailscale',
            form: 'notice',
            summary: boundContextSummary(`/mobile ${task}`),
          },
        }))
        return { kind: 'success', text: '已把需求交给 DSH 处理，改动会在手机端几秒内生效。' }
      },
    })
    try {
      await mobileAccess.startLocal(resolved.extensionsDir, ctx)
      await remoteControllers.tailscale.initialize()
    } catch (error) {
      unregister()
      unregisterFrontend()
      disposeMobileCommand()
      await remoteControllers.tailscale.close()
      await mobileAccess.stopLocal()
      throw error
    }
    return async () => {
      unregister()
      unregisterFrontend()
      disposeMobileCommand()
      await remoteControllers.tailscale.close()
      await mobileAccess.stopLocal()
    }
  }, 'dsh-mobile: Tailscale Serve remote access with /mobile command')
}
