import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { rewriteRemoteMobileIndex, rewriteRemoteMobileIndexWithBatches } from '../src/mobile-frontend.js'
import { MOBILE_LAYOUT_STYLES } from '../src/mobile-layout.js'
import { DSH_MOBILE_MODULE_ID } from '../src/version.js'

// The boot manifest entry id is the published package name. Reading it here
// keeps the fixtures below tied to reality: they used a stale `dsh-mobile`
// literal for a whole release, which silently skipped the settings ordering.
const packageName = (createRequire(import.meta.url)('../package.json') as { name: string }).name

function index(entries: unknown[]): string {
  return `<!doctype html><html><head><script>window.__DSH_BOOT__ = ${JSON.stringify({ rev: 'stock', entries })};</script></head><body></body></html>`
}

function currentIndex(entries: unknown[]): string {
  return `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'stock', entries })};</script></head><body></body></html>`
}

describe('remote phone boot rewrite', () => {
  it('injects the remote boot contract while keeping the stock layout bundle', () => {
    const output = rewriteRemoteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      { id: '@deepseek-ai/dsh-client-ui-conversation', url: '/conversation.js', rev: 'conversation' },
    ]))

    // The remote channel has no gateway to mint a session or a CSRF token, so
    // it declares the authenticated transport and a trusted page instead.
    expect(output).toContain('window.__DSH_TRANSPORT__')
    expect(output).toContain('window.__DSH_MOBILE_TRUSTED_GATEWAY__=true')
    expect(output.indexOf('window.__DSH_TRANSPORT__')).toBeLessThan(output.indexOf('window.__DSH_BOOT__'))
    expect(output).not.toContain('window.__DSH_MOBILE_FRONTEND__')
    expect(output).not.toContain('x-dsh-mobile-csrf')
    expect(output).toContain('"url":"/layout.js"')
    expect(output).not.toContain('/mobile-access/mobile-layout.js')
    expect(output).toContain('"url":"/conversation.js"')
    expect(output).toContain('viewport-fit=cover')
  })

  it('orders the authenticated mobile client before settings without retaining the sidebar cycle', () => {
    const output = rewriteRemoteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-connection', url: '/connection.js', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime', inject: ['@deepseek-ai/dsh-client-connection'] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: '/settings.js',
        rev: 'settings',
        // The DSH 0.1.2 settings module declares only the remotes namespace and
        // no longer depends on connection. Settings must still be ordered after
        // the mobile client, which reads-once trust hint it depends on.
        inject: ['@deepseek-ai/dsh-api-remotes'],
      },
      {
        id: packageName,
        url: '/dsh-mobile.js',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]))

    expect(output).toContain(`"id":"${packageName}","url":"/dsh-mobile.js","rev":"mobile","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-runtime"]`)
    expect(output).toContain(`"id":"@deepseek-ai/dsh-client-ui-settings","url":"/settings.js","rev":"settings","inject":["@deepseek-ai/dsh-api-remotes","${packageName}"]`)
    expect(output).not.toContain(`"inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-sidebar"]`)
  })

  it('locates its own manifest entry by the published package name', () => {
    expect(DSH_MOBILE_MODULE_ID).toBe(packageName)
  })

  it('orders the API gateway after the mobile client on the remote-backed settings graph', () => {
    const output = rewriteRemoteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-connection', url: '/connection.js', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime', inject: ['@deepseek-ai/dsh-client-connection'] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      {
        id: '@deepseek-ai/dsh-api-gateway',
        url: '/gateway.js',
        rev: 'gw',
        inject: ['@deepseek-ai/dsh-client-connection'],
      },
      { id: '@deepseek-ai/dsh-api-remotes', url: '/remotes.js', rev: 'rem', inject: ['@deepseek-ai/dsh-api-gateway'] },
      { id: '@deepseek-ai/dsh-client-ui-settings', url: '/settings.js', rev: 'settings', inject: ['@deepseek-ai/dsh-api-remotes'] },
      {
        id: packageName,
        url: '/dsh-mobile.js',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]))

    // @deepseek-ai/dsh-api-gateway memoizes connection.isLoopback into cached
    // $host facts, so it must not activate before the mobile client installs
    // the trust. This is the edge the upstream plugin carries.
    expect(output).toContain(`"id":"@deepseek-ai/dsh-api-gateway"`)
    expect(output).toContain(`"inject":["@deepseek-ai/dsh-client-connection","${packageName}"]`)
    // The pre-boot override is the primary mechanism and must precede the manifest.
    expect(output).toContain('window.__DSH_TRANSPORT__')
    expect(output.indexOf('window.__DSH_TRANSPORT__')).toBeLessThan(output.indexOf('window.__DSH_BOOT__'))
  })

  it('orders settings after the mobile client on an older connection-based settings graph', () => {
    // A DSH release with settings still depending on connection has no remote
    // settings graph: the extra api-gateway ordering edge is skipped, not required.
    const output = rewriteRemoteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-connection', url: '/connection.js', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime', inject: ['@deepseek-ai/dsh-client-connection'] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: '/settings.js',
        rev: 'settings',
        inject: ['@deepseek-ai/dsh-client-connection'],
      },
      {
        id: packageName,
        url: '/dsh-mobile.js',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]))

    expect(output).toContain(`"inject":["@deepseek-ai/dsh-client-connection","${packageName}"]`)
    expect(output).not.toContain('"id":"@deepseek-ai/dsh-api-gateway"')
  })

  it('rebuilds the DSH 0.1.2 application batch for the remote channel', () => {
    const entries = [
      { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/connection.js?rev=connection', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-ui-renderer', url: '/plugins/renderer.js?rev=renderer', rev: 'renderer', inject: [] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/plugins/layout.js?rev=layout',
        rev: 'layout',
        inject: [
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-renderer',
          '@deepseek-ai/dsh-client-ui-session',
          '@deepseek-ai/dsh-client-ui-theme',
        ],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: '/plugins/settings.js?rev=settings',
        rev: 'settings',
        inject: ['@deepseek-ai/dsh-api-remotes'],
      },
      {
        id: packageName,
        url: '/plugins/dsh-mobile.js?rev=mobile',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]
    const source = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock-batch', entries: entries.map(entry => entry.id) }],
    })};</script></head><body></body></html>`
    const output = rewriteRemoteMobileIndex(source)

    expect(output).toContain('"url":"/plugins/layout.js?rev=layout"')
    expect(output).not.toContain('"url":"/mobile-access/mobile-layout.js"')
    expect(output).toContain(`"inject":["@deepseek-ai/dsh-api-remotes","${packageName}"]`)
    expect(output).toMatch(/"url":"\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js"/u)
    expect(output).not.toContain('/plugins/application.js?rev=stock')
    expect(output).toContain(`"entries":${JSON.stringify(entries.map(entry => entry.id))}`)
  })

  it('leaves the stock layout in place for a layout generation it does not implement', () => {
    // DSH 0.1.7 declares `main` (keyed), `rightbar` and `shell.leading` on the root
    // slot instead of `conversation`/`details`, so substituting the dedicated
    // layout — which declares the old contract — serves a page whose conversation
    // is rendered into a slot nothing declares. The layout module's own dependency
    // list is the only generation marker reachable from the manifest.
    const entries = [
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: [
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-renderer',
          '@deepseek-ai/dsh-client-ui-session',
          '@deepseek-ai/dsh-client-ui-theme',
          '@deepseek-ai/dsh-client-shortcuts',
        ],
      },
      { id: packageName, url: '/mobile.js', rev: 'mobile', inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'] },
      { id: '@deepseek-ai/dsh-client-ui-settings', url: '/settings.js', rev: 'settings', inject: ['@deepseek-ai/dsh-api-remotes'] },
    ]
    const source = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock-batch', entries: entries.map(entry => entry.id) }],
    })};</script></head><body></body></html>`
    const output = rewriteRemoteMobileIndex(source)

    expect(output).toContain('"url":"/layout.js"')
    expect(output).not.toContain('/mobile-access/mobile-layout.js')
    // The batch is still replaced: DSH fetches the whole graph in one combined
    // request, so pruning a module only removes its bytes when this plugin serves
    // that request itself.
    expect(output).toMatch(/"url":"\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js"/u)
    expect(output).not.toContain('/plugins/application.js?rev=stock')
  })

  it('drops the oversized account settings module from the phone graph entirely', () => {
    // `@deepseek-ai/dsh-client-ui-settings-account` is 5,281,067 bytes (~3.7 MB
    // gzip of a 5.8 MB gzip payload) and no module injects it, so removing the
    // entry *and* its bytes only costs the account/billing page.
    const entries = [
      { id: '@deepseek-ai/dsh-client-ui-layout', url: '/layout.js', rev: 'layout', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'] },
      { id: '@deepseek-ai/dsh-client-ui-settings', url: '/settings.js', rev: 'settings', inject: ['@deepseek-ai/dsh-api-remotes'] },
      { id: '@deepseek-ai/dsh-client-ui-settings-account', url: '/settings-account.js', rev: 'account', inject: ['@deepseek-ai/dsh-client-ui-settings'] },
    ]
    const source = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock', entries: entries.map(entry => entry.id) }],
    })};</script></head><body></body></html>`

    const output = rewriteRemoteMobileIndex(source)

    expect(output).not.toContain('settings-account')
    // The rewritten batch is served by this plugin, so the module's bytes never
    // reach the phone even though the stock batch would have carried them.
    expect(output).toMatch(/"url":"\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js"/u)
    expect(output).not.toContain('/plugins/application.js?rev=stock')
  })

  it('drops the third-party modules that cannot render on DSH 0.1.7', () => {
    // `dsh-better-sidebar` requires `@deepseek-ai/dsh-client-ui-primitives`, which
    // 0.1.7 keeps out of the client graph, so its panes die with React #130; and
    // `dsh-rewind-plugin` reads a `snapshot.queue` the host no longer sends and
    // crashes `conversation.session.header.actions`. Neither is injected by
    // another entry, so both leave the phone graph on both channels.
    const entries = [
      { id: '@deepseek-ai/dsh-client-ui-layout', url: '/layout.js', rev: 'layout', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'] },
      { id: 'dsh-better-sidebar', url: '/better-sidebar.js', rev: 'better' },
      { id: 'dsh-rewind-plugin', url: '/rewind.js', rev: 'rewind' },
      { id: packageName, url: '/mobile.js', rev: 'mobile' },
    ]
    const source = currentIndex(entries)

    const output = rewriteRemoteMobileIndex(source)
    expect(output).not.toContain('dsh-better-sidebar')
    expect(output).not.toContain('dsh-rewind-plugin')
    // The remaining graph still activates, including this plugin's own client.
    expect(output).toContain(packageName)
    expect(output).toContain('@deepseek-ai/dsh-client-ui-layout')
  })

  it('does not activate desktop-shell-only modules on a phone page', () => {
    // `dsh-desktop-next` installs two document-wide MutationObservers, one of them
    // unthrottled. Removing the entry keeps it in the combined request but stops it
    // from being activated, so none of its code runs on the phone.
    const entries = [
      { id: '@deepseek-ai/dsh-client-ui-layout', url: '/layout.js', rev: 'layout', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'] },
      { id: 'dsh-desktop-next', url: '/desktop-next.js', rev: 'next', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
    ]
    const source = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock-batch', entries: entries.map(entry => entry.id) }],
    })};</script></head><body></body></html>`

    expect(rewriteRemoteMobileIndex(source)).not.toContain('dsh-desktop-next')
  })

  it('accepts the DSH 0.1.1 global injection syntax', () => {
    const output = rewriteRemoteMobileIndex(currentIndex([
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
    ]))

    expect(output).toContain('globalThis["__DSH_BOOT__"] = {')
    expect(output).toContain('"url":"/layout.js"')
    expect(output).not.toContain('/mobile-access/mobile-layout.js')
  })

  it('adapts stable DSH question surfaces for touch screens', () => {
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-question-key]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-question-scroll]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-key]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-scroll]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-key]>section>div:last-child')
    expect(MOBILE_LAYOUT_STYLES).toContain('max-height:min(42dvh,360px)')
    expect(MOBILE_LAYOUT_STYLES).toContain('height:auto!important')
    expect(MOBILE_LAYOUT_STYLES).toContain('min-height:44px')
  })

  it('fails closed when the upstream page cannot identify one layout module', () => {
    expect(() => rewriteRemoteMobileIndex(index([]))).toThrow('no unique layout module')
    expect(() => rewriteRemoteMobileIndex('<html></html>')).toThrow('no boot manifest')
  })

  it('fails closed when the stock layout dependency contract changes', () => {
    expect(() => rewriteRemoteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-ui-layout', url: '/layout.js', rev: 'layout', inject: ['new-runtime'] },
    ]))).toThrow('unsupported dependencies')
  })
})

describe('remote mobile index rewrite', () => {
  const remoteEntries = () => [
    { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/connection.js?rev=c', rev: 'c', inject: [] },
    { id: '@deepseek-ai/dsh-client-ui-renderer', url: '/plugins/renderer.js?rev=r', rev: 'r', inject: [] },
    {
      id: '@deepseek-ai/dsh-client-ui-layout',
      url: '/plugins/layout.js?rev=l',
      rev: 'l',
      inject: [
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-ui-session',
        '@deepseek-ai/dsh-client-ui-theme',
      ],
    },
    { id: '@deepseek-ai/dsh-client-ui-settings', url: '/plugins/settings.js?rev=s', rev: 's', inject: ['@deepseek-ai/dsh-api-remotes'] },
    {
      id: packageName,
      url: '/plugins/mobile.js?rev=m',
      rev: 'm',
      inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
      immediately: true,
    },
  ]

  it('orders settings after the mobile client and marks the page as a trusted gateway page', () => {
    const output = rewriteRemoteMobileIndex(currentIndex(remoteEntries()))

    expect(output).toContain('window.__DSH_MOBILE_TRUSTED_GATEWAY__=true')
    expect(output).toContain(`"inject":["@deepseek-ai/dsh-api-remotes","${packageName}"]`)
    expect(output).toContain('viewport-fit=cover')
    // The remote channel keeps DSH's own layout and its boot batch.
    expect(output).toContain('"url":"/plugins/layout.js?rev=l"')
    expect(output).not.toContain('/mobile-access/mobile-layout.js')
    expect(output).not.toContain('__DSH_MOBILE_FRONTEND__')
  })

  it('replaces the remote boot batch with one this plugin serves itself', () => {
    const entries = remoteEntries()
    const source = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock', entries: entries.map(entry => entry.id) }],
    })};</script></head><body></body></html>`

    const output = rewriteRemoteMobileIndex(source)

    // The proxy owns this origin, so the plans come back to it instead of going
    // into the LAN gateway's store — which is not reachable when LAN access is off.
    expect(output).toMatch(/"url":"\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js"/u)
    expect(output).not.toContain('/plugins/application.js?rev=stock')
  })

  it('hands the batch plans to the caller alongside the rewritten document', () => {
    const entries = remoteEntries()
    const source = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock', entries: entries.map(entry => entry.id) }],
    })};</script></head><body></body></html>`

    const rewritten = rewriteRemoteMobileIndexWithBatches(source)

    expect(rewritten.batches).toHaveLength(1)
    expect(rewritten.batches?.[0]?.upstream).toEqual({ url: '/plugins/application.js?rev=stock', rev: 'stock' })
    expect(rewritten.batches?.[0]?.entries.map(entry => entry.id)).toEqual(entries.map(entry => entry.id))
    expect(rewritten.batches?.[0]?.path).toBe(`/mobile-access/mobile-boot/${rewritten.batches?.[0]?.key ?? ''}.js`)
  })

  it('fails closed on an unsupported layout contract so the caller can serve the stock page', () => {
    expect(() => rewriteRemoteMobileIndex(currentIndex([
      { id: '@deepseek-ai/dsh-client-ui-layout', url: '/layout.js', rev: 'layout', inject: ['new-runtime'] },
    ]))).toThrow('unsupported dependencies')
  })

  it('declares the transport override before the boot manifest is evaluated', () => {
    const output = rewriteRemoteMobileIndex(currentIndex(remoteEntries()))

    expect(output).toContain('window.__DSH_TRANSPORT__')
    expect(output).toContain('ownsHost:true')
    // Order matters: @deepseek-ai/dsh-client-connection reads
    // globalThis.__DSH_TRANSPORT__ while building its handle, and
    // @deepseek-ai/dsh-api-gateway memoizes isLoopback into cached host facts.
    // Anything after the manifest assignment is too late to matter.
    const transport = output.indexOf('window.__DSH_TRANSPORT__')
    const manifest = output.indexOf('__DSH_BOOT__')
    expect(transport).toBeGreaterThan(-1)
    expect(manifest).toBeGreaterThan(-1)
    expect(transport).toBeLessThan(manifest)
  })

  it('leaves an existing transport override alone instead of blanking the page', () => {
    const output = rewriteRemoteMobileIndex(currentIndex(remoteEntries()))

    // The override statement shares a script block with the manifest assignment,
    // so it must never throw: a throw would take the mobile page down entirely.
    expect(output).not.toContain('throw new Error')
  })
})

describe('remote boot preload hints', () => {
  const entries = [
    { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
    {
      id: '@deepseek-ai/dsh-client-ui-layout',
      url: '/layout.js',
      rev: 'layout',
      inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
    },
    { id: 'feature', url: '/feature.js', rev: 'feature' },
  ]
  const source = '<!doctype html><html><head>'
    + '<link rel="preload" as="script" href="plugins/??feature/client.js&amp;rev=554112994f82">'
    + '<link rel="modulepreload" crossorigin href="plugins/??feature/client.js&amp;rev=9e00d36ccee1">'
    + '<link rel="preload" as="script" href="./assets/vendor-CCJJTK99.js">'
    + '<link rel="stylesheet" crossorigin href="./assets/index-DUvMhLle.css">'
    + '<script src="plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=31537f9b310b"></script>'
    + `<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'stock', entries, batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock', entries: entries.map(entry => entry.id) }] })};</script>`
    + '</head><body></body></html>'

  // A hint still fetches the combination DSH built, which is the whole unpruned
  // graph — including the module the served manifest no longer activates.
  it('drops hints for a stock combined boot request on the remote channel', () => {
    const output = rewriteRemoteMobileIndex(source)
    expect(output).not.toContain('rel="preload" as="script" href="plugins/??')
    expect(output).not.toContain('rel="modulepreload" crossorigin href="plugins/??')
    // Only the boot hints go: every other head resource and the bootstrap script
    // tag that loads the client module loader stay untouched.
    expect(output).toContain('href="./assets/vendor-CCJJTK99.js"')
    expect(output).toContain('rel="stylesheet" crossorigin href="./assets/index-DUvMhLle.css"')
    expect(output).toContain('src="plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=31537f9b310b"')
  })
})

describe('phone session window cap', () => {
  const entries = [
    { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
    {
      id: '@deepseek-ai/dsh-client-ui-layout',
      url: '/layout.js',
      rev: 'layout',
      inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
    },
    { id: packageName, url: '/mobile.js', rev: 'mobile' },
  ]
  const source = currentIndex(entries)

  /**
   * Install the document's own window bootstrap against a fake WebSocket and
   * return what `send` was handed.
   */
  const dispatchedByBootstrap = (html: string, frame: string): string => {
    const bootstrap = html.match(/\(\(\)=>\{const send=WebSocket\.prototype\.send[\s\S]*?\}\)\(\);/u)?.[0]
    expect(bootstrap).toBeDefined()
    const sent: string[] = []
    const FakeWebSocket = function (this: unknown) {} as unknown as { prototype: { send: (data: string) => void } }
    FakeWebSocket.prototype.send = (data: string) => { sent.push(data) }
    const install = new Function('WebSocket', `${String(bootstrap)}\nreturn WebSocket;`) as (target: unknown) => unknown
    install(FakeWebSocket)
    FakeWebSocket.prototype.send(frame)
    return sent.at(-1) ?? ''
  }

  const followFrame = (maxMessages: number, minMessages = 50): string => JSON.stringify({
    type: 'open',
    streamId: 'stream-example',
    endpoint: 'session/follow',
    payload: {
      args: {
        request: {
          address: { kind: 'session', sessionId: 'session-example' },
          assistantStream: true,
          maxMessages,
          turnWindow: { minMessages, minTurns: 2 },
        },
      },
    },
  })

  // DSH 0.1.7 sends session/follow over the WebSocket mux with the desktop's
  // 500-message window. A phone that opens a long conversation then renders all
  // of it, which is what makes opening it slow and every later tap in it slow.
  it('is installed before the boot manifest', () => {
    const output = rewriteRemoteMobileIndex(source)
    expect(output).toContain('WebSocket.prototype.send=function(data)')
    expect(output.indexOf('WebSocket.prototype.send')).toBeLessThan(output.indexOf('__DSH_BOOT__'))
  })

  it('clamps the opening window and drops the Turn floor that outgrows it', () => {
    const output = rewriteRemoteMobileIndex(source)
    const forwarded = JSON.parse(dispatchedByBootstrap(output, followFrame(500))) as {
      payload: { args: { request: { maxMessages: number; turnWindow?: unknown } } }
    }
    // `paginate` cuts at the message count only when no Turn floor is set, and a
    // floor of 2 Turns handed back 291 records for a 50-message request.
    expect(forwarded.payload.args.request.maxMessages).toBe(10)
    expect(forwarded.payload.args.request.turnWindow).toBeUndefined()
  })

  it('forwards every other frame untouched and keeps a smaller window', () => {
    const output = rewriteRemoteMobileIndex(source)
    const smaller = JSON.parse(dispatchedByBootstrap(output, followFrame(4))) as {
      payload: { args: { request: { maxMessages: number; turnWindow?: unknown } } }
    }
    expect(smaller.payload.args.request.maxMessages).toBe(4)
    expect(smaller.payload.args.request.turnWindow).toBeUndefined()
    const other = JSON.stringify({ type: 'open', endpoint: 'session/page', payload: { args: { request: { maxMessages: 500 } } } })
    expect(dispatchedByBootstrap(output, other)).toBe(other)
  })
})

describe('current-generation dedicated layout', () => {
  // DSH 0.1.7's layout injects `@deepseek-ai/dsh-client-shortcuts` and declares
  // `main` (keyed), `rightbar` and `shell.leading`; this plugin ships a second
  // layout module for that contract, served only on an explicit opt-in.
  const markerEntries = [
    { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
    {
      id: '@deepseek-ai/dsh-client-ui-layout',
      url: '/layout.js',
      rev: 'layout',
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-theme',
        '@deepseek-ai/dsh-client-shortcuts',
      ],
    },
    { id: packageName, url: '/mobile.js', rev: 'mobile' },
  ]
  const legacyEntries = [
    { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
    {
      id: '@deepseek-ai/dsh-client-ui-layout',
      url: '/layout.js',
      rev: 'layout',
      inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
    },
    { id: packageName, url: '/mobile.js', rev: 'mobile' },
  ]
  const layoutEntry = (html: string): { url?: string | undefined; rev?: string | undefined } => {
    const match = /\{"id":"@deepseek-ai\/dsh-client-ui-layout","url":"([^"]*)","rev":"([^"]*)"/u.exec(html)
    return match === null ? {} : { url: match[1], rev: match[2] }
  }

  it('keeps DSH own layout on the current generation unless mobileLayout is mobile', () => {
    const source = currentIndex(markerEntries)
    for (const output of [
      rewriteRemoteMobileIndex(source),
      rewriteRemoteMobileIndex(source, 'auto'),
      rewriteRemoteMobileIndex(source, 'stock'),
    ]) {
      expect(layoutEntry(output).url).toBe('/layout.js')
    }
    const remote = rewriteRemoteMobileIndexWithBatches(source, 'auto')
    expect(layoutEntry(remote.html).url).toBe('/layout.js')
  })

  it('serves the current-generation layout module when asked', () => {
    const source = currentIndex(markerEntries)
    for (const output of [
      rewriteRemoteMobileIndex(source, 'mobile'),
      rewriteRemoteMobileIndexWithBatches(source, 'mobile').html,
    ]) {
      expect(layoutEntry(output).url).toBe('/mobile-access/mobile-layout-next.js')
      expect(layoutEntry(output).rev).toMatch(/^dsh-mobile-layout-next-/u)
    }
  })

  it('does not serve the current-generation module to an older manifest', () => {
    const source = currentIndex(legacyEntries)
    // `mobile` may replace only the generation the module implements: an older
    // three-child root has no substitute on the remote channel, so it keeps the
    // stock layout rather than the current-generation bundle.
    const output = rewriteRemoteMobileIndex(source, 'mobile')
    expect(layoutEntry(output).url).toBe('/layout.js')
    expect(layoutEntry(output).url).not.toBe('/mobile-access/mobile-layout-next.js')
  })
})

describe('phone terminal key repair', () => {
  const source = currentIndex([
    { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
    {
      id: '@deepseek-ai/dsh-client-ui-layout',
      url: '/layout.js',
      rev: 'layout',
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-theme',
        '@deepseek-ai/dsh-client-shortcuts',
      ],
    },
    { id: packageName, url: '/mobile.js', rev: 'mobile' },
  ])
  const shim = rewriteRemoteMobileIndex(source).match(/\(\(\)=>\{const PROBE="\/mobile-access\/key-probe"[\s\S]*?\}\)\(\);/u)?.[0]

  interface FakeEvent {
    readonly type: string
    readonly isTrusted: boolean
    readonly key: string
    readonly keyCode: number
    readonly inputType?: string
    readonly data?: string
    readonly target: FakeElement
  }

  interface FakeElement {
    readonly closest: (selector: string) => unknown
    readonly isConnected: boolean
    readonly value: string
    readonly dispatchEvent: (event: FakeEvent) => void
  }

  /**
   * Run the injected repair against a fake terminal. `traffic` stands for a
   * terminal that already put the key on the wire itself, `viaInput` for a phone
   * whose keydown the terminal ignored and whose `input` event never reached it
   * either.
   */
  const runKey = async (options: { key?: string; keyCode?: number; traffic?: boolean; viaInput?: boolean; phone?: boolean }): Promise<{ dispatched: FakeEvent[]; frames: string[]; reported: unknown[] }> => {
    expect(shim).toBeDefined()
    const key = options.key ?? ' '
    const dispatched: FakeEvent[] = []
    const frames: string[] = []
    const reported: unknown[] = []
    const captures = new Map<string, (event: FakeEvent) => void>()
    const element = {
      closest: (selector: string) => (selector === '.xterm' ? element : null),
      isConnected: true,
      value: '',
      dispatchEvent: (event: FakeEvent) => {
        dispatched.push(event)
        // xterm listens on the terminal element and forwards what it understands.
        if (event.type === 'keydown' && event.key.length === 1) frames.push(JSON.stringify({ endpoint: 'terminal/input', data: event.key }))
      },
    }
    const FakeWebSocket = function (this: unknown) {} as unknown as { prototype: { send: (data: string) => void } }
    FakeWebSocket.prototype.send = (data: string) => { frames.push(data) }
    const document = {
      documentElement: { classList: { contains: (token: string) => (options.phone ?? true) && token === 'dsh-native-mobile-active' } },
      addEventListener: (type: string, handler: (event: FakeEvent) => void) => { captures.set(type, handler) },
    }
    class FakeKeyboardEvent {
      readonly type: string
      readonly isTrusted = false
      readonly key: string
      readonly keyCode: number
      readonly target: FakeElement
      constructor(type: string, init: Record<string, unknown>) {
        this.type = type
        this.key = String(init.key ?? '')
        this.keyCode = Number(init.keyCode ?? 0)
        this.target = element
      }
    }
    const fakeFetch = (_url: string, init?: { body?: string }) => {
      if (typeof init?.body === 'string') reported.push(JSON.parse(init.body) as unknown)
      return Promise.resolve({})
    }
    const install = new Function('WebSocket', 'document', 'window', 'KeyboardEvent', `${String(shim)}\n`) as (
      ws: unknown,
      doc: unknown,
      win: unknown,
      event: unknown,
    ) => void
    install(FakeWebSocket, document, { setTimeout, fetch: fakeFetch }, FakeKeyboardEvent)

    if (options.viaInput === true) {
      captures.get('input')?.({ type: 'input', isTrusted: true, key: '', keyCode: 0, inputType: 'insertText', data: key, target: element } as FakeEvent)
    } else {
      captures.get('keydown')?.({ type: 'keydown', isTrusted: true, key, keyCode: options.keyCode ?? 229, target: element } as FakeEvent)
    }
    if (options.traffic === true) FakeWebSocket.prototype.send(JSON.stringify({ endpoint: 'terminal/input', data: key }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    return { dispatched, frames, reported }
  }

  it('re-dispatches the space the terminal dropped', async () => {
    const { dispatched, frames, reported } = await runKey({})
    // The keydown is what xterm acts on; the keypress is its legacy fallback and
    // is dropped by xterm itself once the keydown was handled.
    expect(dispatched.map(event => event.type)).toEqual(['keydown', 'keypress'])
    expect(dispatched.every(event => event.keyCode === 32)).toBe(true)
    expect(frames.some(frame => frame.includes('terminal/input'))).toBe(true)
    expect(reported).toHaveLength(1)
  })

  it('re-dispatches a symbol on the US key code xterm forwards', async () => {
    // xterm forwards a single-character key only when the key code is at least
    // 48, so a dropped ',' has to come back as 188, not as the IME's 229.
    const { dispatched, frames } = await runKey({ key: ',', keyCode: 229 })
    expect(dispatched.map(event => event.keyCode)).toEqual([188, 188])
    expect(frames.some(frame => frame.includes('","')) || frames.some(frame => frame.includes('","'))).toBe(true)
    expect(dispatched[0]?.key).toBe(',')
  })

  it('keeps the legacy 229 for a character no physical key produces', async () => {
    const { dispatched } = await runKey({ key: '，', keyCode: 229 })
    expect(dispatched.map(event => event.keyCode)).toEqual([229, 229])
    expect(dispatched[0]?.key).toBe('，')
  })

  it('repairs a key that only arrived as text, which is the shape iOS sends', async () => {
    const { dispatched } = await runKey({ key: '?', viaInput: true })
    expect(dispatched.map(event => event.type)).toEqual(['keydown', 'keypress'])
    expect(dispatched[0]?.key).toBe('?')
    expect(dispatched[0]?.keyCode).toBe(191)
  })

  it('leaves a key alone once the terminal put it on the wire itself', async () => {
    const { dispatched } = await runKey({ key: ';', traffic: true })
    expect(dispatched).toHaveLength(0)
  })

  it('never fires outside the phone surface', async () => {
    const { dispatched } = await runKey({ phone: false })
    expect(dispatched).toHaveLength(0)
  })
})
