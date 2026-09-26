import { describe, expect, it, vi } from 'vitest'
import {
  collectConnectionDiagnostics,
  remoteDiagnosticTimeoutMs,
  type DiagnosticSnapshot,
} from '../src/diagnostics.js'
import { DSH_MOBILE_VERSION } from '../src/version.js'

const healthy: DiagnosticSnapshot = {
  dshVersion: '0.1.1-rc.2',
  remote: {
    provider: 'tailscale',
    running: true,
    state: 'ready',
    origin: 'https://desktop-qiushenjie.taile854bf.ts.net',
  },
}

function remoteCheck(result: Awaited<ReturnType<typeof collectConnectionDiagnostics>>) {
  return result.checks.find(entry => entry.id === 'remote')
}

describe('connection diagnostics', () => {
  it('allows known remote relays longer than direct endpoints', () => {
    expect(remoteDiagnosticTimeoutMs('https://desktop-qiushenjie.taile854bf.ts.net')).toBe(10_000)
    expect(remoteDiagnosticTimeoutMs('https://example.tail1234.ts.net')).toBe(10_000)
    expect(remoteDiagnosticTimeoutMs('https://example.com')).toBe(5_000)
  })

  it('summarizes a healthy remote path without copying the exact address', async () => {
    const result = await collectConnectionDiagnostics(healthy, {
      remote: async () => ({ state: 'ready', latencyMs: 86 }),
    })

    expect(result.overall).toBe('ok')
    expect(result.versions).toEqual({ plugin: DSH_MOBILE_VERSION, dsh: '0.1.1-rc.2' })
    expect(Object.keys(result.versions).sort()).toEqual(['dsh', 'plugin'])
    expect(result.checks.map(entry => entry.id)).toEqual(['versions', 'remote', 'phone-network'])
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'versions', status: 'ok' }),
      expect.objectContaining({ id: 'remote', status: 'ok', detail: expect.stringContaining('86 ms') }),
      expect.objectContaining({ id: 'phone-network', status: 'info' }),
    ]))
    expect(result.report).toContain('DSH Mobile 诊断报告')
    expect(result.report).toContain('endpoint=*.ts.net')
    expect(result.report).toContain(`版本: plugin=${DSH_MOBILE_VERSION}; dsh=0.1.1-rc.2`)
    expect(result.report).not.toContain('desktop-qiushenjie')
    expect(result.report).not.toContain('taile854bf')
  })

  it('reports the disabled state without probing and without copying the address', async () => {
    const probe = vi.fn(async () => ({ state: 'ready' as const }))
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'tailscale', running: false, state: 'off', origin: 'https://secret.tail1234.ts.net' },
    }, { remote: probe })

    expect(probe).not.toHaveBeenCalled()
    expect(result.overall).toBe('ok')
    expect(remoteCheck(result)).toMatchObject({
      status: 'info',
      detail: '当前未启用。',
      action: '打开远程访问开关即可生成手机可用的地址。',
    })
    expect(result.report).toContain('endpoint=*.ts.net')
    expect(result.report).not.toContain('secret')
  })

  it('reports a not-yet-assigned endpoint without a probe', async () => {
    const probe = vi.fn(async () => ({ state: 'ready' as const }))
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'tailscale', running: true, state: 'ready' },
    }, { remote: probe })

    expect(probe).not.toHaveBeenCalled()
    expect(result.report).toContain('endpoint=未分配')
    expect(result.report).toContain('Remote: provider=tailscale; state=ready; endpoint=未分配')
  })

  it('redacts a public non-tailnet HTTPS address', async () => {
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'tailscale', running: true, state: 'ready', origin: 'https://198.51.100.7:8443' },
    }, { remote: async () => ({ state: 'ready', latencyMs: 12 }) })

    expect(result.report).toContain('endpoint=公共 HTTPS 地址')
    expect(result.report).not.toContain('198.51.100.7')
    expect(result.report).not.toContain('8443')
  })

  it('reports observed provider throttling without claiming an account quota', async () => {
    const result = await collectConnectionDiagnostics(healthy, {
      remote: async () => ({ state: 'rate-limited', latencyMs: 210 }),
    })

    expect(result.overall).toBe('attention')
    expect(remoteCheck(result)).toMatchObject({
      status: 'warning',
      detail: expect.stringContaining('观察到服务限流'),
    })
  })

  it('explains a failed Tailscale Fake-IP path without blaming the computer certificate', async () => {
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'tailscale', running: true, state: 'ready', origin: 'https://example.tail1234.ts.net' },
    }, {
      remote: async () => ({ state: 'unreachable', fakeIp: true }),
    })

    expect(result.overall).toBe('error')
    expect(remoteCheck(result)).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('VPN 或 DNS 代理'),
      action: expect.stringContaining('Switch VPN node'),
    })
  })

  it('reports a plain unreachable endpoint as a provider problem', async () => {
    const result = await collectConnectionDiagnostics(healthy, {
      remote: async () => ({ state: 'unreachable' }),
    })

    expect(result.overall).toBe('error')
    expect(remoteCheck(result)).toMatchObject({
      status: 'error',
      detail: '提供方显示已就绪，但公共地址暂不可达。',
      action: '点击“重新连接”；仍失败时检查 Tailscale 状态。',
    })
  })

  it('maps provider error codes onto the shortest recovery action', async () => {
    const failing = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'tailscale', running: true, state: 'error', errorCode: 'serve_failed' },
    }, { remote: async () => ({ state: 'not-applicable' }) })

    expect(failing.overall).toBe('error')
    expect(remoteCheck(failing)).toMatchObject({
      detail: '连接未建立（serve_failed）。',
      action: 'Check the network, then click Reconnect.',
    })

    const unknown = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'tailscale', running: true, state: 'error', errorCode: 'something_new' },
    }, { remote: async () => ({ state: 'not-applicable' }) })

    expect(remoteCheck(unknown)).toMatchObject({
      detail: '连接未建立（something_new）。',
      action: '返回远程访问页点击“重新连接”。',
    })
  })

  it('keeps an in-progress connection at attention instead of failing it', async () => {
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'tailscale', running: true, state: 'needs-login' },
    })

    expect(result.overall).toBe('attention')
    expect(remoteCheck(result)).toMatchObject({
      status: 'warning',
      detail: '等待完成 Tailscale 登录。',
      action: '在电脑上完成 Tailscale 登录后重新检查。',
    })
  })
})
