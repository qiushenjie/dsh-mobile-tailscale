import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MobileAccessControlStore } from '../src/control.js'
import type { RemotePassthroughProxy } from '../src/remote-proxy.js'
import { TailscaleServeController } from '../src/tailscale-serve.js'

/**
 * Install a fake `tailscale` executable that records every invocation and
 * answers `status --json` with the supplied node state, so the whole Serve
 * lifecycle can be driven without touching the real node.
 * @param statusJson - Body returned by `tailscale status --json`.
 * @returns The executable path and a reader for the recorded invocations.
 */
async function fakeTailscale(statusJson: unknown): Promise<{
  readonly bin: string
  readonly calls: () => Promise<string[]>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tailscale-'))
  const log = join(directory, 'calls.txt')
  const bin = join(directory, 'tailscale')
  await writeFile(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'case "$*" in',
    `  *"status --json"*) printf '%s' ${JSON.stringify(JSON.stringify(statusJson))} ;;`,
    'esac',
    'exit 0',
    '',
  ].join('\n'), 'utf8')
  await chmod(bin, 0o755)
  return {
    bin,
    calls: async () => {
      try {
        return (await readFile(log, 'utf8')).split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
  }
}

/** A control store fixed to one persisted switch value. */
function store(enabled: boolean): MobileAccessControlStore {
  return {
    load: async () => ({ version: 1 as const, enabled }),
    save: async () => undefined,
  }
}

/** A proxy stand-in that records how often it was started and closed. */
function fakeProxy(): {
  readonly proxy: RemotePassthroughProxy
  readonly starts: () => number
  readonly closes: () => number
} {
  let starts = 0
  let closes = 0
  const proxy = {
    start: async () => { starts += 1 },
    origin: () => 'http://127.0.0.1:54321',
    close: async () => { closes += 1 },
  } as unknown as RemotePassthroughProxy
  return { proxy, starts: () => starts, closes: () => closes }
}

const HEALTHY_NODE = { Self: { DNSName: 'node.tailnet.ts.net.' } }

describe('Tailscale Serve lifecycle', () => {
  it('does not touch serve when the switch is restored as disabled', async () => {
    const { bin, calls } = await fakeTailscale(HEALTHY_NODE)
    const { proxy, starts } = fakeProxy()
    const controller = new TailscaleServeController({ store: store(false), proxy, bin })

    await controller.initialize()

    // A fresh install persists enabled: false. Running `serve --https=443 off`
    // here would tear down an unrelated 443 entry the user configured, on every
    // boot, for a plugin that never owned it. Nothing of ours was started
    // either, so no proxy is left behind.
    expect(await calls()).toEqual([])
    expect(starts()).toBe(0)
    expect(controller.status()).toEqual({ enabled: false, state: 'off' })
  })

  it('registers serve on enable and clears it on an explicit disable', async () => {
    const { bin, calls } = await fakeTailscale(HEALTHY_NODE)
    const { proxy, closes } = fakeProxy()
    const controller = new TailscaleServeController({ store: store(true), proxy, bin })

    await controller.initialize()
    expect(controller.status()).toMatchObject({ state: 'ready', origin: 'https://node.tailnet.ts.net/' })
    expect((await calls()).some((call) => call.startsWith('serve --bg --yes --https=443 ')))
      .toBe(true)

    await controller.setEnabled(false)

    expect(await calls()).toContain('serve --https=443 off')
    expect(closes()).toBeGreaterThan(0)
    expect(controller.status()).toEqual({ enabled: false, state: 'off' })
  })

  it('removes the entry it just created when the run fails afterwards', async () => {
    // `status --json` without a MagicDNS name makes resolveOrigin throw *after*
    // the 443 entry has been registered. Previously the catch only closed the
    // proxy, leaving serve pointing at a dead loopback port.
    const { bin, calls } = await fakeTailscale({ Self: {} })
    const { proxy, closes } = fakeProxy()
    const controller = new TailscaleServeController({ store: store(true), proxy, bin })

    await controller.initialize()

    expect(controller.status().state).toBe('error')
    expect(await calls()).toContain('serve --https=443 off')
    expect(closes()).toBeGreaterThan(0)
  })
})
