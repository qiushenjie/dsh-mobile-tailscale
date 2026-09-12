/**
 * Tailscale Serve remote transport: exposes the configured upstream over the
 * machine's own Tailscale node as a private tailnet HTTPS origin
 * (`https://<hostname>.<tailnet>.ts.net`). No Funnel (nothing is public), no
 * pairing gateway (tailnet membership is the access control) — a phone with
 * Tailscale on the same tailnet just opens the origin. This is the connection
 * method of the DSH Remote project, adapted to the dsh-mobile plugin surface.
 *
 * The serve targets the plugin's {@link RemotePassthroughProxy} loopback
 * listener rather than the DSH web server directly: the proxy rewrites
 * Host/Origin to the live upstream (resolved from `DSH_WEB_URL` per request),
 * which both bypasses the DSH browser-trust fence and follows the web server
 * across desktop/CLI restarts without manual re-pointing. Starting also
 * recovers the common stale-config failure where port 443 is already serving a
 * TCP forward (or another entry) by clearing it when safe and retrying once.
 * @module dsh-mobile-tailscale/tailscale-serve
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MobileAccessControlStore } from './control.js'
import type { RemotePassthroughProxy } from './remote-proxy.js'

/** Status of the Tailscale Serve remote transport, matching the Funnel shape. */
export interface TailscaleServeStatus {
  readonly enabled: boolean
  readonly state: 'off' | 'starting' | 'ready' | 'unavailable' | 'error'
  readonly origin?: string
  readonly loginUrl?: string
  readonly setupUrl?: string
  readonly errorCode?: string
}

/** Construction inputs for one Tailscale Serve lifecycle. */
export interface TailscaleServeControllerOptions {
  /** Persisted on/off switch shared with the desktop control card. */
  readonly store: MobileAccessControlStore
  /** Loopback proxy exposing the live DSH web upstream behind the serve origin. */
  readonly proxy: RemotePassthroughProxy
  /** tailscale CLI binary name or absolute path; defaults to PATH resolution. */
  readonly bin?: string
  readonly onStatus?: (status: TailscaleServeStatus) => void
}

const execFileAsync = promisify(execFile)

function publicStatus(status: TailscaleServeStatus): TailscaleServeStatus {
  return Object.freeze({
    enabled: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  })
}

/**
 * A Serve failure whose diagnostic code is already known.
 *
 * The port-443 recovery path raises both of its errors itself, and their text
 * ("…is occupied by another service") matched none of the message patterns
 * below, so the panel reported the generic `serve_failed` instead of
 * `serve_port_conflict`. Carrying the code explicitly keeps the classification
 * from depending on wording.
 */
class ServeDiagnosticError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ServeDiagnosticError'
  }
}

/** Whether a failed `tailscale serve` invocation is the port-443 occupancy failure. */
function isServePortConflict(error: unknown): boolean {
  if (error instanceof ServeDiagnosticError) return error.code === 'serve_port_conflict'
  const message = error instanceof Error ? error.message : String(error)
  return /already serving|already in use|cannot serve|port .*?(?:busy|conflict|in use)/i.test(message)
}

/** Classify a failed `tailscale` invocation into a stable diagnostic code. */
function classifyServeError(error: unknown): string {
  if (error instanceof ServeDiagnosticError) return error.code
  const message = error instanceof Error ? error.message : String(error)
  if (/not logged in|logged out|login required|no node key/i.test(message)) return 'tailscale_not_logged_in'
  if (/funnel/i.test(message)) return 'funnel_unavailable'
  if (/EACCES|EPERM/i.test(message)) return 'permission_denied'
  if (/ENOENT/i.test(message)) return 'tailscale_missing'
  if (isServePortConflict(error)) return 'serve_port_conflict'
  return 'serve_failed'
}

/**
 * Owns the `tailscale serve` process, the machine's MagicDNS origin, the
 * loopback passthrough proxy, and the persisted remote switch. Enabling starts
 * the proxy, runs `tailscale serve --bg --https=443 <proxy origin>` and
 * reports the resolved `https://<hostname>.<tailnet>.ts.net`; disabling runs
 * `tailscale serve --https=443 off` and stops the proxy.
 */
export class TailscaleServeController {
  private enabled = false
  private initialized = false
  private disposed = false
  private latest: TailscaleServeStatus = Object.freeze({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: TailscaleServeControllerOptions) {}

  /** Restore the remote switch without coupling it to LAN availability. */
  async initialize(): Promise<void> {
    const state = await this.options.store.load()
    this.enabled = state.enabled
    this.initialized = true
    if (this.enabled) await this.start()
      else {
        // A disabled switch means this plugin does not own `serve`, not that
        // `serve` should be cleared. `tailscale serve --https=443 off` is a
        // node-global side effect that would tear down an unrelated 443 entry
        // the user configured themselves, on every boot, because a fresh
        // install persists `enabled: false`. There is nothing of ours to stop
        // here either: nothing was started, so the proxy is already closed.
        await this.closeProxy()
        this.publish({ enabled: false, state: 'off' })
      }
  }

  /** Return state safe for the local desktop control UI. */
  status(): TailscaleServeStatus {
    return this.latest
  }

  /** Enable or disable Tailscale Serve without changing the LAN listener. */
  async setEnabled(enabled: boolean): Promise<TailscaleServeStatus> {
    if (!this.initialized || this.disposed) throw new Error('Tailscale Serve controller is unavailable')
    await this.enqueue(async () => {
      if (this.enabled === enabled) return
      this.enabled = enabled
      await this.options.store.save({ version: 1, enabled })
      if (enabled) await this.start()
      else {
        await this.stopServe()
        this.publish({ enabled: false, state: 'off' })
      }
    })
    return this.status()
  }

  /** Restart a failed or interrupted Serve session while retaining the switch. */
  async reconnect(): Promise<TailscaleServeStatus> {
    if (!this.initialized || this.disposed) throw new Error('Tailscale Serve controller is unavailable')
    await this.enqueue(async () => {
      if (!this.enabled) {
        this.enabled = true
        await this.options.store.save({ version: 1, enabled: true })
      }
      await this.stopServe()
      await this.start()
    })
    return this.status()
  }

  /** Disable Serve; the tailnet origin is a property of the Tailscale node, so there is no private state to clear. */
  async reset(): Promise<TailscaleServeStatus> {
    if (!this.initialized || this.disposed) throw new Error('Tailscale Serve controller is unavailable')
    await this.enqueue(async () => {
      await this.stopServe()
      this.enabled = false
      await this.options.store.save({ version: 1, enabled: false })
      this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** No gateway: the serve exposes the upstream (DSH web) directly. */
  gateway(): undefined {
    return undefined
  }

  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.enqueue(() => this.stopServe())
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private publish(status: TailscaleServeStatus): void {
    this.latest = publicStatus(status)
    try {
      this.options.onStatus?.(this.latest)
    } catch {
      // A status listener must not break the controller.
    }
  }

  private bin(): string {
    return this.options.bin ?? 'tailscale'
  }

  private async start(): Promise<void> {
    this.publish({ enabled: true, state: 'starting' })
    try {
      await this.runServe()
      const origin = await this.resolveOrigin()
      this.publish({ enabled: true, state: 'ready', origin })
    } catch (error) {
      // `runServe` registers the 443 entry before `resolveOrigin` reads the
      // MagicDNS name back, so a failure after the registration would otherwise
      // leave `serve` pointing at a proxy we are about to close — the phone
      // then sees connection-refused while the panel reports an error. Clear
      // the entry we just created, then report.
      try { await this.stopServe() } catch {
        // The proxy must not mask the serve error reported below.
      }
      this.publish({ enabled: true, state: 'error', errorCode: classifyServeError(error) })
    }
  }

  private async runServe(): Promise<void> {
    await this.options.proxy.start()
    const target = this.options.proxy.origin()
    try {
      await this.applyServe(target)
    } catch (error) {
      if (isServePortConflict(error)) {
        await this.recoverServePortConflict()
        await this.applyServe(target)
      } else {
        throw error
      }
    }
  }

  private async applyServe(target: string): Promise<void> {
    await execFileAsync(this.bin(), ['serve', '--bg', '--yes', '--https=443', target], {
      windowsHide: true,
      timeout: 30_000,
    })
  }

  /**
   * Clear a stale port-443 occupancy so the HTTPS serve can register. Only
   * when 443 is the sole serve entry is it safe to reset the whole config;
   * otherwise the conflict is surfaced as a dedicated diagnostic code.
   */
  private async recoverServePortConflict(): Promise<void> {
    let status: unknown
    try {
      const { stdout } = await execFileAsync(this.bin(), ['serve', 'status', '--json'], {
        windowsHide: true,
        timeout: 30_000,
      })
      status = JSON.parse(stdout) as unknown
    } catch {
      throw new ServeDiagnosticError('serve_port_conflict', 'serve port 443 is occupied by another service and its status could not be read')
    }
    const tcp = (status as { TCP?: Record<string, unknown> })?.TCP
    const entries = tcp === undefined || tcp === null ? [] : Object.keys(tcp)
    if (entries.length !== 1 || entries[0] !== '443') {
      throw new ServeDiagnosticError('serve_port_conflict', 'serve port 443 is occupied by another service')
    }
    await execFileAsync(this.bin(), ['serve', 'reset'], {
      windowsHide: true,
      timeout: 30_000,
    })
  }

  private async stopServe(): Promise<void> {
    try {
      await execFileAsync(this.bin(), ['serve', '--https=443', 'off'], {
        windowsHide: true,
        timeout: 30_000,
      })
    } catch {
      // Turning serve off when nothing is configured is harmless.
    }
    await this.closeProxy()
  }

  /** Stop the loopback proxy if it is running. Never touches `tailscale serve`. */
  private async closeProxy(): Promise<void> {
    try {
      await this.options.proxy.close()
    } catch {
      // A proxy that failed to close must not break the disable flow.
    }
  }

  private async resolveOrigin(): Promise<string> {
    const { stdout } = await execFileAsync(this.bin(), ['status', '--json'], {
      windowsHide: true,
      timeout: 30_000,
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error('tailscale status --json is not valid JSON')
    }
    const self = (parsed as { Self?: { DNSName?: unknown } }).Self
    const dnsName = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/u, '') : undefined
    if (dnsName === undefined || dnsName === '') throw new Error('tailscale status did not report a MagicDNS name')
    return `https://${dnsName}/`
  }
}
