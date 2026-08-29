/**
 * Tailscale Serve remote transport: exposes the configured upstream over the
 * machine's own Tailscale node as a private tailnet HTTPS origin
 * (`https://<hostname>.<tailnet>.ts.net`). No Funnel (nothing is public), no
 * pairing gateway (tailnet membership is the access control) — a phone with
 * Tailscale on the same tailnet just opens the origin. This is the connection
 * method of the DSH Remote project, adapted to the dsh-mobile plugin surface.
 * @module dsh-mobile-tailscale/tailscale-serve
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MobileAccessControlStore } from './control.js'

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
  /** Upstream the serve proxies to (the DSH web loopback origin). */
  readonly upstream: string
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

/** Classify a failed `tailscale` invocation into a stable diagnostic code. */
function classifyServeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/not logged in|logged out|login required|no node key/i.test(message)) return 'tailscale_not_logged_in'
  if (/funnel/i.test(message)) return 'funnel_unavailable'
  if (/EACCES|EPERM/i.test(message)) return 'permission_denied'
  if (/ENOENT/i.test(message)) return 'tailscale_missing'
  return 'serve_failed'
}

/**
 * Owns the `tailscale serve` process, the machine's MagicDNS origin, and the
 * persisted remote switch. Enabling runs `tailscale serve --bg --https=443
 * <upstream>` and reports the resolved `https://<hostname>.<tailnet>.ts.net`;
 * disabling runs `tailscale serve --https=443 off`.
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
    else this.publish({ enabled: false, state: 'off' })
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
      else this.publish({ enabled: false, state: 'off' })
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
      this.publish({ enabled: true, state: 'error', errorCode: classifyServeError(error) })
    }
  }

  private async runServe(): Promise<void> {
    await execFileAsync(this.bin(), ['serve', '--bg', '--yes', '--https=443', this.options.upstream], {
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