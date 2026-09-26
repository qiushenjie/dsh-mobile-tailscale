import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { isLoopbackAddress } from './network.js'

/** Operator-facing plugin configuration. */
export interface PluginConfig {
  /**
   * Internal state anchor. The remote control preference, its provider
   * selection, and the local extension root are all derived from its directory.
   */
  stateFile: string
  /** Loopback origin of the DSH Web application the remote channel forwards to. */
  upstreamOrigin?: string
  /** Optional user stylesheet served to the phone UI. */
  customCssFile?: string
  /** Optional user script that mounts phone-only Web features. */
  customScriptFile?: string
  /** Internal dedicated mobile layout browser bundle. */
  mobileLayoutFile?: string
  /** Internal dedicated mobile layout bundle for the current DSH layout generation. */
  mobileLayoutNextFile?: string
  /**
   * Which layout a phone gets: `auto` keeps DSH's own layout unless this plugin
   * implements the generation the manifest was built for, `mobile` also serves
   * the dedicated mobile layout on the current generation, `stock` never
   * replaces the layout.
   */
  mobileLayout?: 'auto' | 'mobile' | 'stock'
  maxWebSockets?: number
  maxBodyBytes?: number
  upstreamTimeoutMs?: number
}

/** Resolved, validated remote-channel configuration. */
export interface ResolvedMobileConfig {
  readonly upstreamOrigin: URL
  readonly stateFile: string
  /** Directory holding the remote control file, provider selection, and extensions. */
  readonly stateDirectory: string
  /** Local extension root adjacent to the mobile-access state file. */
  readonly extensionsDir: string
  readonly customCssFile: string
  readonly customScriptFile: string
  readonly mobileLayoutFile: string
  /** Dedicated layout bundle for the layout generation that DSH 0.1.7 ships. */
  readonly mobileLayoutNextFile: string
  readonly mobileLayout: 'auto' | 'mobile' | 'stock'
  readonly maxWebSockets: number
  readonly maxBodyBytes: number
  readonly upstreamTimeoutMs: number
}

/** Loader-facing defaults; {@link parseMobileConfig} enforces cross-field rules. */
export const Config: z<PluginConfig> = z.object({
  stateFile: String,
  upstreamOrigin: z.string(),
  customCssFile: z.string().hidden(),
  customScriptFile: z.string().hidden(),
  mobileLayoutFile: z.string().hidden(),
  mobileLayoutNextFile: z.string().hidden(),
  mobileLayout: z.union([z.const('auto'), z.const('mobile'), z.const('stock')]).default('auto'),
  maxWebSockets: z.natural(),
  maxBodyBytes: z.natural(),
  upstreamTimeoutMs: z.natural(),
})

function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer from ${String(minimum)} through ${String(maximum)}`)
  }
  return resolved
}

function absoluteFile(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute file path`)
  }
  return resolve(value)
}

export function parseUpstream(value: unknown): URL {
  const source = value ?? 'http://127.0.0.1:3080'
  if (typeof source !== 'string') throw new Error('upstreamOrigin must be a string')
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new Error('upstreamOrigin must be an HTTP loopback origin')
  }
  if (url.protocol !== 'http:' || !isLoopbackAddress(url.hostname) || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.port === '') {
    throw new Error('upstreamOrigin must be an HTTP loopback origin with an explicit port and no path or credentials')
  }
  return url
}

/** Parse configuration and reject unsafe upstream and resource combinations. */
export function parseMobileConfig(raw: unknown): ResolvedMobileConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('mobile-access config must be an object')
  const value = raw as PluginConfig
  const stateFile = absoluteFile(value.stateFile, 'stateFile')
  const stateDirectory = dirname(stateFile)
  const defaultAsset = (name: string, configured: unknown): string => configured === undefined
    ? fileURLToPath(new URL(`./${name}`, import.meta.url))
    : absoluteFile(configured, name)
  return Object.freeze({
    upstreamOrigin: parseUpstream(value.upstreamOrigin),
    stateFile,
    stateDirectory,
    extensionsDir: join(stateDirectory, 'extensions'),
    customCssFile: value.customCssFile === undefined
      ? join(stateDirectory, 'mobile.css')
      : absoluteFile(value.customCssFile, 'customCssFile'),
    customScriptFile: value.customScriptFile === undefined
      ? join(stateDirectory, 'mobile.js')
      : absoluteFile(value.customScriptFile, 'customScriptFile'),
    mobileLayoutFile: defaultAsset('mobile-layout.js', value.mobileLayoutFile),
    mobileLayoutNextFile: defaultAsset('mobile-layout-next.js', value.mobileLayoutNextFile),
    mobileLayout: value.mobileLayout ?? 'auto',
    maxWebSockets: integer(value.maxWebSockets, 'maxWebSockets', 16, 1, 256),
    maxBodyBytes: integer(value.maxBodyBytes, 'maxBodyBytes', 160 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    upstreamTimeoutMs: integer(value.upstreamTimeoutMs, 'upstreamTimeoutMs', 30_000, 1_000, 300_000),
  })
}
