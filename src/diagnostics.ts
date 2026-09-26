import { lookup } from 'node:dns/promises'
import { DSH_MOBILE_VERSION } from './version.js'

export type DiagnosticStatus = 'ok' | 'warning' | 'error' | 'info'

/** One user-facing diagnostic result with an optional shortest recovery action. */
export interface DiagnosticCheck {
  readonly id: string
  readonly status: DiagnosticStatus
  readonly label: string
  readonly detail: string
  readonly action?: string
}

/** Runtime facts available without exposing credentials or local file paths. */
export interface DiagnosticSnapshot {
  readonly dshVersion: string
  readonly remote: {
    readonly provider: 'tailscale'
    readonly running: boolean
    readonly state: string
    readonly origin?: string
    readonly errorCode?: string
  }
}

interface RemoteObservation {
  readonly state: 'ready' | 'rate-limited' | 'unreachable' | 'not-applicable'
  readonly latencyMs?: number
  readonly fakeIp?: boolean
}

/** Injectable probes keep diagnostics deterministic in tests. */
export interface DiagnosticProbes {
  readonly remote?: (origin: string | undefined) => Promise<RemoteObservation>
}

/** Sanitized diagnostic response copied by the desktop UI. */
export interface ConnectionDiagnostics {
  readonly version: 1
  readonly generatedAt: number
  readonly overall: 'ok' | 'attention' | 'error'
  readonly versions: {
    readonly plugin: string
    readonly dsh: string
  }
  readonly summary: string
  readonly checks: readonly DiagnosticCheck[]
  readonly report: string
}

const REMOTE_ERROR_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  component_missing: 'Reinstall the complete plugin package.',
  tailscale_not_logged_in: 'Confirm Tailscale is logged in and on the same tailnet, then reconnect.',
  tailscale_missing: 'Install Tailscale and retry.',
  tailscale_not_running: 'Connect Tailscale (its backend is stopped), then reconnect.',
  permission_denied: 'Run DSH as administrator and retry.',
  serve_failed: 'Check the network, then click Reconnect.',
})

function check(
  id: string,
  status: DiagnosticStatus,
  label: string,
  detail: string,
  action?: string,
): DiagnosticCheck {
  return Object.freeze({ id, status, label, detail, ...(action === undefined ? {} : { action }) })
}

function remoteSuffix(origin: string | undefined): string {
  if (origin === undefined) return '未分配'
  try {
    const hostname = new URL(origin).hostname
    if (hostname.endsWith('.ts.net')) return '*.ts.net'
    return '公共 HTTPS 地址'
  } catch {
    return '地址格式无效'
  }
}

/** Allow the tailnet relay enough time to answer without making diagnostics unbounded. */
export function remoteDiagnosticTimeoutMs(origin: string): number {
  const hostname = new URL(origin).hostname.toLowerCase()
  if (hostname.endsWith('.ts.net')) return 10_000
  return 5_000
}

async function defaultRemoteProbe(origin: string | undefined): Promise<RemoteObservation> {
  if (origin === undefined) return { state: 'not-applicable' }
  const hostname = new URL(origin).hostname
  const started = performance.now()
  try {
    const response = await fetch(new URL('/mobile-access/health', origin), {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(remoteDiagnosticTimeoutMs(origin)),
    })
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    if (response.status === 429) return { state: 'rate-limited', latencyMs }
    return response.ok ? { state: 'ready', latencyMs } : { state: 'unreachable', latencyMs }
  } catch {
    let fakeIp = false
    try {
      const addresses = await lookup(hostname, { all: true })
      fakeIp = addresses.some(({ address }) => {
        const [first, second] = address.split('.').map(Number)
        return first === 198 && (second === 18 || second === 19)
      })
    } catch {
      // DNS lookup is supplementary; the failed HTTPS probe remains authoritative.
    }
    return { state: 'unreachable', ...(fakeIp ? { fakeIp: true } : {}) }
  }
}

function reportLine(entry: DiagnosticCheck): string {
  return `[${entry.status.toUpperCase()}] ${entry.label}: ${entry.detail}${entry.action === undefined ? '' : ` ${entry.action}`}`
}

/** Run bounded read-only checks and return a report safe to paste into an issue. */
export async function collectConnectionDiagnostics(
  snapshot: DiagnosticSnapshot,
  probes: DiagnosticProbes = {},
): Promise<ConnectionDiagnostics> {
  const checks: DiagnosticCheck[] = []
  const remoteProbe = snapshot.remote.running && snapshot.remote.state === 'ready' && snapshot.remote.origin !== undefined
    ? (probes.remote ?? defaultRemoteProbe)(snapshot.remote.origin)
    : Promise.resolve<RemoteObservation>({ state: 'not-applicable' })
  const remoteObservation = await remoteProbe
  checks.push(check(
    'versions',
    'ok',
    '版本兼容',
    `插件 ${DSH_MOBILE_VERSION}，DSH ${snapshot.dshVersion}。`,
  ))

  if (!snapshot.remote.running || snapshot.remote.state === 'off') {
    checks.push(check('remote', 'info', '远程访问', '当前未启用。', '打开远程访问开关即可生成手机可用的地址。'))
  } else if (snapshot.remote.state === 'ready' && snapshot.remote.origin !== undefined) {
    if (remoteObservation.state === 'ready') {
      checks.push(check('remote', 'ok', '远程访问', `${snapshot.remote.provider} 公共地址 ${remoteSuffix(snapshot.remote.origin)} 可达，往返约 ${String(remoteObservation.latencyMs ?? 0)} ms。`))
    } else if (remoteObservation.state === 'rate-limited') {
      checks.push(check('remote', 'warning', '远程访问', '公共地址可达，但本次检查观察到服务限流。', '稍后重试；旧会话会按需加载以减少流量。'))
    } else if (snapshot.remote.provider === 'tailscale' && remoteObservation.fakeIp === true) {
      checks.push(check(
        'remote',
        'error',
        '远程访问',
        'Tailscale 地址被当前 VPN 或 DNS 代理接管，但 TLS 链路未建立。',
        'Switch VPN node or proxy mode, then retry.',
      ))
    } else {
      checks.push(check('remote', 'error', '远程访问', '提供方显示已就绪，但公共地址暂不可达。', '点击“重新连接”；仍失败时检查 Tailscale 状态。'))
    }
  } else if (snapshot.remote.state === 'starting' || snapshot.remote.state === 'connecting' || snapshot.remote.state === 'needs-login') {
    checks.push(check(
      'remote',
      'warning',
      '远程访问',
      snapshot.remote.state === 'needs-login' ? '等待完成 Tailscale 登录。' : '仍在建立连接。',
      snapshot.remote.state === 'needs-login' ? '在电脑上完成 Tailscale 登录后重新检查。' : '等待片刻后重新检查。',
    ))
  } else {
    checks.push(check(
      'remote',
      'error',
      '远程访问',
      `连接未建立（${snapshot.remote.errorCode ?? snapshot.remote.state}）。`,
      REMOTE_ERROR_GUIDANCE[snapshot.remote.errorCode ?? ''] ?? '返回远程访问页点击“重新连接”。',
    ))
  }

  checks.push(check(
    'phone-network',
    'info',
    '手机网络',
    '公共地址只有加入了同一 tailnet 的设备能打开。',
    '在手机上安装并登录 Tailscale；未加入 tailnet 的设备无法访问。',
  ))

  const overall = checks.some(entry => entry.status === 'error')
    ? 'error'
    : checks.some(entry => entry.status === 'warning') ? 'attention' : 'ok'
  const summary = overall === 'ok' ? '连接基础检查正常。' : overall === 'attention' ? '发现需要留意的项目。' : '发现会影响连接的问题。'
  const report = [
    'DSH Mobile 诊断报告',
    `生成时间: ${new Date().toISOString()}`,
    `版本: plugin=${DSH_MOBILE_VERSION}; dsh=${snapshot.dshVersion}`,
    `Remote: provider=${snapshot.remote.provider}; state=${snapshot.remote.state}; endpoint=${remoteSuffix(snapshot.remote.origin)}`,
    ...checks.map(reportLine),
  ].join('\n')
  return Object.freeze({
    version: 1,
    generatedAt: Date.now(),
    overall,
    versions: Object.freeze({ plugin: DSH_MOBILE_VERSION, dsh: snapshot.dshVersion }),
    summary,
    checks: Object.freeze(checks),
    report,
  })
}
