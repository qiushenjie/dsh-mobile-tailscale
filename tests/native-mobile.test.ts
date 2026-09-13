import { describe, expect, it } from 'vitest'
import { NATIVE_MOBILE_STYLES, isComposerEditorFocus, isMenuSearchFocus, preservesMenuFocus, selectsSidebarRow, shouldAutoLoadEarlier } from '../src/native-mobile.js'

/** Minimal stand-in for an element whose `closest` resolves to a fixed match. */
function fakeElement(closest: Element | null): Element {
  return { closest: () => closest } as unknown as Element
}

/** Stand-in for a sidebar row; `aria-expanded` is the only state the guard reads. */
function fakeRow(ariaExpanded: string | null): Element {
  return {
    getAttribute: (name: string) => (name === 'aria-expanded' ? ariaExpanded : null),
  } as unknown as Element
}

/** Stand-in for a focus target with fixed `matches` and configurable containment. */
function fakeFocusTarget(matches: boolean, inComposer: boolean, inMenu = false): Element {
  return {
    matches: () => matches,
    closest: (selector: string) => {
      const inside = selector.includes('menu') ? inMenu : inComposer
      return inside ? ({} as unknown as Element) : null
    },
  } as unknown as Element
}

describe('native mobile presentation', () => {
  it('keeps touch focus quiet without removing keyboard focus globally', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('-webkit-tap-highlight-color:transparent')
    expect(NATIVE_MOBILE_STYLES).toContain('data-dsh-mobile-input="touch"')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-sidebar] [role="treeitem"] { -webkit-tap-highlight-color:transparent; touch-action:manipulation; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[role="tooltip"] { display:none !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-sidebar] { --dsw-alias-interactive-bg-hover:transparent !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-sidebar] [role="treeitem"]:is(:hover,:active,:focus,[aria-selected="true"])')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_sessionRow"][class*="_selected"],')
    expect(NATIVE_MOBILE_STYLES).toContain('padding-top:max(4px,env(safe-area-inset-top)) !important')
    expect(NATIVE_MOBILE_STYLES).toContain('inset:max(env(safe-area-inset-top),0px) auto 0 0 !important; height:auto !important')
    expect(NATIVE_MOBILE_STYLES).toContain('width:min(88vw,340px) !important; padding-top:0 !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_logoRow"] { height:52px !important; padding:4px 0 4px 4px !important; margin-bottom:4px !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('inset:env(safe-area-inset-top) 0 0; border:0; background:rgb(15 23 42 / 32%)')
    expect(NATIVE_MOBILE_STYLES).toContain('box-sizing:border-box !important; width:50px !important; height:52px !important; padding:4px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-toggle] > svg[class*="_railFish"] { transform:translateY(-4px) !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:32px !important; height:32px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:28px !important; height:28px !important; margin-top:0 !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_tab"] { padding-bottom:5px !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('width:max-content !important; max-width:calc(100% - 58px) !important')
    expect(NATIVE_MOBILE_STYLES).toContain('width:calc(100% - 16px) !important; margin:0 8px !important')
    expect(NATIVE_MOBILE_STYLES).not.toContain(':is([data-dsh-mobile-header], header)')
    expect(NATIVE_MOBILE_STYLES).not.toContain('[data-dsh-mobile-toggle] svg { display:none !important; }')
    expect(NATIVE_MOBILE_STYLES).not.toContain('[data-dsh-mobile-toggle]::after')
    expect(NATIVE_MOBILE_STYLES).not.toContain('html.dsh-native-mobile-active :focus { outline:none')
  })

  it('stacks narrow settings and conversation metadata instead of squeezing text', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('data-slot="settings.general.item"')
    expect(NATIVE_MOBILE_STYLES).toContain('flex-direction:column !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-disclosure-row]')
    expect(NATIVE_MOBILE_STYLES).toContain('gap:10px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-message-scroll] { box-sizing:border-box !important; width:100% !important')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:40px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('line-height:19px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('grid-template-columns:16px minmax(0,1fr)')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-context-fields]')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-composer-card] ~ * [class*="_root"]')
    expect(NATIVE_MOBILE_STYLES).toContain('white-space:normal !important; overflow:visible !important')
    expect(NATIVE_MOBILE_STYLES).toContain('margin-bottom:-6px !important')
    expect(NATIVE_MOBILE_STYLES).not.toContain('dsh-native-mobile-attach')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-row] { display:grid !important; grid-template-columns:max-content minmax(0,1fr) !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-trailing] { display:flex !important; flex-wrap:nowrap !important; width:100% !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-model] { flex:1 1 0 !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-model-label] { flex:1 1 auto !important; max-width:none !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-history-loader] button:not(:disabled)')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-history-loader] button:disabled')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowHead"]:has(> [class*="_rowIdentity"]) { flex-wrap:nowrap !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowActions"] { flex:0 0 auto !important; flex-wrap:nowrap !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowActions"] button { flex:none !important; width:auto !important; min-width:44px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('white-space:nowrap !important; word-break:keep-all !important; writing-mode:horizontal-tb !important')
  })

  it('loads older history only after an upward scroll reaches the top zone', () => {
    expect(shouldAutoLoadEarlier(180, 64)).toBe(true)
    expect(shouldAutoLoadEarlier(65, 64)).toBe(true)
    expect(shouldAutoLoadEarlier(64, 64)).toBe(false)
    expect(shouldAutoLoadEarlier(40, 48)).toBe(false)
    expect(shouldAutoLoadEarlier(180, 80)).toBe(false)
  })

  it('treats a row control as a control, not as selecting the row', () => {
    const row = fakeRow(null)
    // A plain row body (no interactive ancestor) selects the row.
    expect(selectsSidebarRow(fakeElement(null), row)).toBe(true)
    // The row itself being the interactive element still selects it.
    expect(selectsSidebarRow(fakeElement(row), row)).toBe(true)
    // The ellipsis menu button inside the row must not collapse the sidebar and
    // tear its own open menu down.
    expect(selectsSidebarRow(fakeElement({} as unknown as Element), row)).toBe(false)
  })

  it('keeps the sidebar open when a project header toggles its session list', () => {
    // The Workspace (project) header is a `role="treeitem"` too, but it carries
    // `aria-expanded` and no `aria-selected`: its click opens/closes the nested
    // session list in place. Counting it as a selection closed the drawer over
    // the list the user had just opened.
    const expanded = fakeRow('true')
    const collapsed = fakeRow('false')
    // The title/folder spans resolve to no interactive ancestor, which is
    // exactly the case the control check alone would have called a selection.
    expect(selectsSidebarRow(fakeElement(null), expanded)).toBe(false)
    expect(selectsSidebarRow(fakeElement(null), collapsed)).toBe(false)
    // Nor may the header count as a selection when it is its own click target.
    expect(selectsSidebarRow(fakeElement(expanded), expanded)).toBe(false)
    // A session row never announces `aria-expanded`, so it still collapses.
    expect(selectsSidebarRow(fakeElement(null), fakeRow(null))).toBe(true)
  })

  it('guards only the composer editor against programmatic focus', () => {
    // The composer editor: the field the app focuses when a session opens.
    expect(isComposerEditorFocus(fakeFocusTarget(true, true))).toBe(true)
    // A contenteditable outside the composer card is not this layer's business.
    expect(isComposerEditorFocus(fakeFocusTarget(true, false))).toBe(false)
    // The model menu's search field is an input inside the composer card: it
    // must keep its focus, or the menu's own blur handler closes it.
    expect(isComposerEditorFocus(fakeFocusTarget(false, true))).toBe(false)
  })

  it('keeps focus inside an open menu so tapping a model row can still click', () => {
    // Faithful stand-ins for the two containers the stock menu renders: the
    // root pane (focus on a cell) and the model pane (focus on the search
    // field). `contains` is the only structural relation the guard uses.
    const searchInput = { id: 'search' } as unknown as Element
    const modelRow = { id: 'row' } as unknown as Element
    const cell = { id: 'cell' } as unknown as Element
    const menu = {
      contains: (node: Element | null) => node === searchInput || node === cell,
    } as unknown as Element

    // The failure that broke model selection on the phone: the menu's search
    // field holds focus, the user presses a model row, and the mousedown
    // default would move focus out of the container — whose own blur handler
    // then unmounts the menu before mouseup, so no click is ever dispatched.
    expect(preservesMenuFocus(menu, modelRow, searchInput)).toBe(true)

    // Drilling from one root-pane cell to the other already keeps focus inside
    // the container (that is why it worked while selecting did not).
    expect(preservesMenuFocus(menu, cell, cell)).toBe(true)

    // Nothing focused inside the menu: leave the default alone.
    expect(preservesMenuFocus(menu, modelRow, null)).toBe(false)
    expect(preservesMenuFocus(menu, modelRow, { id: 'outside' } as unknown as Element)).toBe(false)

    // A press that is not on a menu item, or not inside a menu at all, must not
    // have its default cancelled.
    expect(preservesMenuFocus(menu, null, searchInput)).toBe(false)
    expect(preservesMenuFocus(null, modelRow, searchInput)).toBe(false)
  })

  it('mutes the keyboard only for the menu search field, never the composer', () => {
    expect(isMenuSearchFocus(fakeFocusTarget(true, false, true))).toBe(true)
    // A search field outside a menu is not ours to manage.
    expect(isMenuSearchFocus(fakeFocusTarget(true, false, false))).toBe(false)
    // The composer editor is handled by isComposerEditorFocus instead; muting
    // its keyboard would break typing entirely.
    expect(isMenuSearchFocus(fakeFocusTarget(false, true, true))).toBe(false)
  })

  it('uses bounded motion and disables every added animation for reduced motion', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('--dsh-mobile-motion-duration:200ms')
    expect(NATIVE_MOBILE_STYLES).toContain('@keyframes dsh-mobile-view-in')
    expect(NATIVE_MOBILE_STYLES).toContain('@media (prefers-reduced-motion:reduce)')
    expect(NATIVE_MOBILE_STYLES).not.toContain('dsh-native-mobile-sheet')
  })
})
