import { dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Config, parseMobileConfig, parseUpstream } from '../src/config.js'

const stateFile = join(tmpdir(), 'dsh-mobile-access-config-test.json')

describe('remote-channel configuration', () => {
  it('keeps durable state required at the Loader boundary', () => {
    const load = Config as unknown as (value?: unknown) => unknown
    expect(() => load()).toThrow(/stateFile missing required value/)
    expect(() => load({})).toThrow(/stateFile missing required value/)
  })

  it('tolerates unknown keys and applies the remote-channel defaults', () => {
    const resolved = parseMobileConfig({
      stateFile,
      // Keys from the deleted LAN gateway must be ignored, not rejected.
      listenPort: 3443,
      controlFile: '/tmp/control.json',
      initiallyEnabled: false,
      tls: { mode: 'disabled' },
    })

    expect(resolved.upstreamOrigin.origin).toBe('http://127.0.0.1:3080')
    expect(resolved.stateFile).toBe(stateFile)
    expect(resolved.stateDirectory).toBe(dirname(stateFile))
    expect(resolved.extensionsDir).toBe(join(dirname(stateFile), 'extensions'))
    expect(resolved.customCssFile).toBe(join(dirname(stateFile), 'mobile.css'))
    expect(resolved.customScriptFile).toBe(join(dirname(stateFile), 'mobile.js'))
    expect(isAbsolute(resolved.mobileLayoutFile)).toBe(true)
    expect(resolved.mobileLayoutFile.endsWith('mobile-layout.js')).toBe(true)
    expect(isAbsolute(resolved.mobileLayoutNextFile)).toBe(true)
    expect(resolved.mobileLayoutNextFile.endsWith('mobile-layout-next.js')).toBe(true)
    expect(resolved.mobileLayout).toBe('auto')
    expect(resolved.maxWebSockets).toBe(16)
    expect(resolved.maxBodyBytes).toBe(160 * 1024 * 1024)
    expect(resolved.upstreamTimeoutMs).toBe(30_000)
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('requires an absolute state file and rejects non-object configuration', () => {
    expect(() => parseMobileConfig({ stateFile: 'devices.json' })).toThrow(/stateFile must be an absolute file path/)
    expect(() => parseMobileConfig({ stateFile: '' })).toThrow(/stateFile must be an absolute file path/)
    expect(() => parseMobileConfig({ stateFile: 42 })).toThrow(/stateFile must be an absolute file path/)
    expect(() => parseMobileConfig(undefined)).toThrow(/mobile-access config must be an object/)
    expect(() => parseMobileConfig(null)).toThrow(/mobile-access config must be an object/)
    expect(() => parseMobileConfig([])).toThrow(/mobile-access config must be an object/)
  })

  it.each([
    'https://127.0.0.1:3080',
    'http://192.168.1.5:3080',
    'http://user:pass@127.0.0.1:3080',
    'http://127.0.0.1:3080/path',
    'http://127.0.0.1',
    'http://localhost:3080',
  ])('rejects unsafe upstream %s', (upstreamOrigin) => {
    expect(() => parseMobileConfig({ stateFile, upstreamOrigin })).toThrow(/upstreamOrigin/)
  })

  it('accepts loopback HTTP upstreams with an explicit port', () => {
    expect(parseMobileConfig({ stateFile, upstreamOrigin: 'http://127.0.0.1:3080' }).upstreamOrigin.origin)
      .toBe('http://127.0.0.1:3080')
    expect(parseUpstream(undefined).origin).toBe('http://127.0.0.1:3080')
    expect(() => parseUpstream(12)).toThrow(/upstreamOrigin must be a string/)
  })

  it('rejects an IPv6 loopback literal because WHATWG hostnames keep the brackets', () => {
    // src/config.ts:92 hands `url.hostname` straight to isLoopbackAddress, and
    // `new URL('http://[::1]:8080').hostname` is the bracketed "[::1]" which
    // node:net no longer classifies as an IP address: only 127.x works today.
    expect(() => parseMobileConfig({ stateFile, upstreamOrigin: 'http://[::1]:8080' }))
      .toThrow(/upstreamOrigin must be an HTTP loopback origin/)
  })

  it('honours explicit asset overrides and the layout mode', () => {
    const resolved = parseMobileConfig({
      stateFile,
      upstreamOrigin: 'http://127.0.0.1:3080',
      customCssFile: join(tmpdir(), 'custom.css'),
      customScriptFile: join(tmpdir(), 'custom.js'),
      mobileLayoutFile: join(tmpdir(), 'layout.js'),
      mobileLayoutNextFile: join(tmpdir(), 'layout-next.js'),
      mobileLayout: 'stock',
      maxWebSockets: 64,
      maxBodyBytes: 1024,
      upstreamTimeoutMs: 300_000,
    })
    expect(resolved.customCssFile).toBe(join(tmpdir(), 'custom.css'))
    expect(resolved.customScriptFile).toBe(join(tmpdir(), 'custom.js'))
    expect(resolved.mobileLayoutFile).toBe(join(tmpdir(), 'layout.js'))
    expect(resolved.mobileLayoutNextFile).toBe(join(tmpdir(), 'layout-next.js'))
    expect(resolved.mobileLayout).toBe('stock')
    expect(resolved.maxWebSockets).toBe(64)
    expect(resolved.maxBodyBytes).toBe(1024)
    expect(resolved.upstreamTimeoutMs).toBe(300_000)
  })

  it('rejects relative asset overrides', () => {
    expect(() => parseMobileConfig({ stateFile, customCssFile: 'mobile.css' })).toThrow(/customCssFile must be an absolute file path/)
    expect(() => parseMobileConfig({ stateFile, customScriptFile: 'mobile.js' })).toThrow(/customScriptFile must be an absolute file path/)
    expect(() => parseMobileConfig({ stateFile, mobileLayoutFile: 'layout.js' })).toThrow(/mobile-layout\.js must be an absolute file path/)
    expect(() => parseMobileConfig({ stateFile, mobileLayoutNextFile: 'layout-next.js' })).toThrow(/mobile-layout-next\.js must be an absolute file path/)
  })

  it('bounds the resource limits instead of clamping them', () => {
    expect(() => parseMobileConfig({ stateFile, maxWebSockets: 0 })).toThrow(/maxWebSockets must be an integer from 1 through 256/)
    expect(() => parseMobileConfig({ stateFile, maxWebSockets: 257 })).toThrow(/maxWebSockets must be an integer from 1 through 256/)
    expect(() => parseMobileConfig({ stateFile, maxWebSockets: 1.5 })).toThrow(/maxWebSockets must be an integer/)
    expect(() => parseMobileConfig({ stateFile, maxBodyBytes: 1023 })).toThrow(/maxBodyBytes must be an integer from 1024 through/)
    expect(() => parseMobileConfig({ stateFile, maxBodyBytes: 256 * 1024 * 1024 + 1 })).toThrow(/maxBodyBytes/)
    expect(() => parseMobileConfig({ stateFile, upstreamTimeoutMs: 999 })).toThrow(/upstreamTimeoutMs must be an integer from 1000 through 300000/)
    expect(() => parseMobileConfig({ stateFile, upstreamTimeoutMs: 300_001 })).toThrow(/upstreamTimeoutMs/)
  })
})
