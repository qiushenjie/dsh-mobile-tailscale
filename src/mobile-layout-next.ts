/**
 * Dedicated mobile layout for the DSH layout generation that ships
 * `main` (keyed), `rightbar` and `shell.leading`.
 *
 * The stock layout module registers `root` with those five children and owns a
 * three-column frame with drag handles, a viewport ResizeObserver and a layout
 * store. A phone does not need any of that, and paying for it on every
 * interaction is what makes a phone feel stuck: measured with a CDP trace, one
 * left-sidebar toggle spent 591 ms of main-thread time at 6x CPU throttling
 * (141 ms of React click handling, 99 ms of style recalculation, 106 ms of
 * paint, 48 ms of layout) — all of it on the desktop frame.
 *
 * This module implements the same contract for a phone: the sidebar becomes a
 * drawer, the right panel becomes a second drawer, and the keyed `main` slot
 * renders whichever panel is selected (the conversation by default) full width.
 * It deliberately keeps the service surface consumers use — `toggleSidebar`,
 * `selectPanel`, `panelInfo`, `beginNavigation`, `openRightbar`, `closeRightbar`
 * and `dispose` — because `@deepseek-ai/dsh-client-ui-sidebar`,
 * `-ui-sidebar-right`, `-ui-plugin-manager` and `-ui-open-in-app` all call it.
 */

import { createElement, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { MOBILE_LAYOUT_STYLES } from './mobile-layout.js'

interface PanelInfo {
  activePanelId: string | null
}

interface MobileLayoutInfo {
  sidebar: number
  viewportWidth: number
  narrowExpanded: boolean
  rightbar: number | null
  rightbarShown: boolean
  rightbarTrack: boolean
  rightbarFullscreen: boolean
  rightbarInstant: boolean
}

interface MobileLayoutState {
  panelInfo: PanelInfo
  layoutInfo: MobileLayoutInfo
}

interface StoreInstance {
  getSnapshot: () => MobileLayoutState
  subscribe: (listener: () => void) => () => void
  actions: Record<string, (...args: never[]) => unknown>
}

/** DSH's client store factory; a platform seed word the shell bundles. */
declare function require(id: '@deepseek-ai/dsh-client-store'): {
  defineStore: <T>(options: {
    init: () => T
    actions: Record<string, (draft: T, ...args: never[]) => void>
  }) => { create: () => StoreInstance }
}

const { defineStore } = require('@deepseek-ai/dsh-client-store')

/** Store the frame and every consumer of the layout service share. */
function createMobileLayoutStore(): { create: () => StoreInstance } {
  return defineStore<MobileLayoutState>({
    init: () => ({
      panelInfo: { activePanelId: null },
      layoutInfo: {
        sidebar: 0,
        viewportWidth: typeof window === 'undefined' ? 390 : window.innerWidth,
        // A phone frame is always below the desktop auto-collapse breakpoint, so
        // this is the drawer's open flag.
        narrowExpanded: false,
        rightbar: null,
        rightbarShown: false,
        rightbarTrack: false,
        rightbarFullscreen: false,
        rightbarInstant: false,
      },
    }),
    actions: {
      selectPanel: (draft: MobileLayoutState, panelId: string | null) => {
        draft.panelInfo.activePanelId = panelId
      },
      retainMainPanels: (draft: MobileLayoutState, panelIds: string[]) => {
        if (draft.panelInfo.activePanelId !== null && !panelIds.includes(draft.panelInfo.activePanelId)) {
          draft.panelInfo.activePanelId = null
        }
      },
      toggleSidebar: (draft: MobileLayoutState) => {
        draft.layoutInfo.narrowExpanded = !draft.layoutInfo.narrowExpanded
      },
      closeSidebar: (draft: MobileLayoutState) => {
        draft.layoutInfo.narrowExpanded = false
      },
      openRightbar: (draft: MobileLayoutState, track: boolean, fullscreen: boolean) => {
        draft.layoutInfo.rightbarShown = true
        draft.layoutInfo.rightbarTrack = track
        draft.layoutInfo.rightbarFullscreen = fullscreen
      },
      closeRightbar: (draft: MobileLayoutState) => {
        draft.layoutInfo.rightbarShown = false
        draft.layoutInfo.rightbarTrack = false
        draft.layoutInfo.rightbarFullscreen = false
      },
      setViewportWidth: (draft: MobileLayoutState, px: number) => {
        draft.layoutInfo.viewportWidth = px
      },
    },
  })
}

/**
 * The `layout` service consumers resolve through `ctx.layout`.
 *
 * Mirrors the stock controller's public surface: panel selection validates that
 * the panel is registered (a bad id means a blank frame otherwise), navigation
 * can be cancelled, and the sidebar/right panel actions go through the store so
 * every subscriber re-renders from one snapshot.
 */
class MobileLayoutController {
  private navigation = new AbortController()

  constructor(
    private readonly panels: Record<string, (...args: never[]) => unknown>,
    private readonly hasMainPanel: (id: string) => boolean,
    readonly panelInfo: { readonly getSnapshot: () => PanelInfo; readonly subscribe: (listener: () => void) => () => void },
  ) {}

  selectPanel(panelId: string | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    this.panels.selectPanel?.(panelId as never)
  }

  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  dispose(): void {
    this.navigation.abort()
  }

  toggleSidebar(): void {
    this.panels.toggleSidebar?.()
  }

  openRightbar(track: boolean, fullscreen: boolean): void {
    this.panels.openRightbar?.(track as never, fullscreen as never)
  }

  closeRightbar(): void {
    this.panels.closeRightbar?.()
  }
}

interface ThemeSnapshot {
  readonly active: {
    readonly colorScheme: 'dark' | 'light'
    readonly tokens: Readonly<Record<string, string>>
  }
}

interface MobileNextContext {
  readonly effect: (effect: () => void | (() => void), label?: string) => void
  readonly on: (event: string, listener: (value: ThemeSnapshot) => void) => () => void
  readonly reflect: { provide: (name: string, value: unknown) => () => void | Promise<void> }
  readonly slots: {
    register: (options: Record<string, unknown>, component: (props: FrameProps) => ReactNode) => () => void
    entries: (name: string) => readonly { readonly options: Record<string, unknown> }[]
    provideRoot: (options: Record<string, unknown>) => () => void
  }
  readonly theme: { getTheme: () => ThemeSnapshot }
}

interface FrameProps {
  readonly renderSlot: (name: string, owner: Record<string, unknown>, options?: Record<string, unknown>) => ReactNode
  readonly useStore: <T>(selector: (state: MobileLayoutState) => T) => T
  readonly usePanelInfo: <T>(selector: (info: PanelInfo) => T) => T
  readonly actions?: Record<string, (...args: never[]) => unknown>
}

class ThemePresenter {
  private appliedTokens: string[] = []
  private readonly meta = document.createElement('meta')

  constructor() {
    this.meta.name = 'theme-color'
  }

  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark')
    for (const name of this.appliedTokens) document.body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      document.body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.meta.content = getComputedStyle(document.body).backgroundColor
    if (!this.meta.isConnected) document.head.append(this.meta)
  }

  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    document.body.removeAttribute('data-ds-dark-theme')
    for (const name of this.appliedTokens) document.body.style.removeProperty(name)
    this.meta.remove()
  }
}

/** Phone frame: drawer sidebar, full-width keyed main panel, drawer right panel. */
function MobileAppFrame(props: FrameProps): ReactNode {
  const sidebarOpen = props.useStore(state => state.layoutInfo.narrowExpanded)
  const rightbarShown = props.useStore(state => state.layoutInfo.rightbarShown)
  const activePanelId = props.usePanelInfo(info => info.activePanelId)
  const viewportWidth = props.useStore(state => state.layoutInfo.viewportWidth)

  useEffect(() => {
    const onViewportChange = (): void => { props.actions?.setViewportWidth?.(window.innerWidth as never) }
    window.addEventListener('resize', onViewportChange)
    return () => { window.removeEventListener('resize', onViewportChange) }
  }, [props.actions])

  const frameRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const element = frameRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const width = element.getBoundingClientRect().width
        if (width > 0) props.actions?.setViewportWidth?.(width as never)
      })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [props.actions])

  return createElement('div', { className: 'dshm-shell', ref: frameRef },
    createElement('main', { className: 'dshm-main' }, props.renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })),
    createElement('button', {
      'aria-label': '关闭浮层',
      className: 'dshm-scrim',
      'data-open': sidebarOpen || rightbarShown,
      onClick: () => { props.actions?.closeSidebar?.(); props.actions?.closeRightbar?.() },
      tabIndex: sidebarOpen || rightbarShown ? 0 : -1,
      type: 'button',
    }),
    createElement('aside', {
      'aria-label': '工作区与会话导航',
      className: 'dshm-drawer',
      'data-open': sidebarOpen,
    }, props.renderSlot('sidebar', { collapsed: !sidebarOpen, width: sidebarOpen ? 340 : 56 })),
    createElement('aside', {
      'aria-hidden': !rightbarShown,
      className: 'dshm-details',
      'data-open': rightbarShown,
      ...(rightbarShown ? {} : { inert: '' }),
    }, props.renderSlot('rightbar', {
      width: Math.min(viewportWidth * 0.94, 460),
      viewportWidth,
      canShow: rightbarShown,
    })),
    createElement('div', { className: 'dshm-overlay', 'data-shell-overlay': true }, props.renderSlot('shell.overlay', {})),
    createElement('div', { className: 'dshm-leading', 'data-shell-leading': true }, props.renderSlot('shell.leading', {})),
  )
}

/** Replace the current-generation layout module on the authenticated mobile surface. */
export function apply(ctx: MobileNextContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-mobile-layout-next'
    style.textContent = MOBILE_LAYOUT_STYLES
    document.head.append(style)

    const handle = createMobileLayoutStore()
    const instance = handle.create()
    const store = { ...handle, create: () => instance }
    const hasMainPanel = (id: string): boolean => ctx.slots.entries('main').some(entry => entry.options.key === id)
    const layout = new MobileLayoutController(
      instance.actions as Record<string, (...args: never[]) => unknown>,
      hasMainPanel,
      {
        getSnapshot: () => instance.getSnapshot().panelInfo,
        subscribe: listener => instance.subscribe(listener),
      },
    )
    instance.actions.retainMainPanels?.(
      ctx.slots.entries('main')
        .map(entry => entry.options.key)
        .filter((key): key is string => typeof key === 'string') as never,
    )
    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      locale: 'common',
      children: {
        sidebar: { kind: 'single', scope: 'root' },
        main: { kind: 'keyed', scope: 'root' },
        rightbar: { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'shell.leading': { kind: 'single', scope: 'root' },
      },
      store,
    }, props => createElement(MobileAppFrame, props))

    return () => {
      disposeRegistration()
      void disposeService()
      disposePanelInfo()
      layout.dispose()
      style.remove()
    }
  }, 'dsh-mobile: dedicated current-generation layout')

  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', snapshot => { presenter.apply(snapshot) })
    return () => { off(); presenter.dispose() }
  }, 'dsh-mobile: theme presenter (current generation)')
}

/** Preserve the official layout module's dependency ordering. */
export const inject: readonly string[] = ['slots', 'theme']

// Keeps the shared layout styles referenced for older bundlers that tree-shake
// an unused import in this entry.
export { MOBILE_LAYOUT_STYLES }
