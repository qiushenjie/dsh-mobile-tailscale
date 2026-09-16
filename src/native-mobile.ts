/** Mobile feature and compatibility rules applied to DSH React surfaces. */
export const NATIVE_MOBILE_STYLES = `
/* iOS inflates text in wide (landscape) viewports unless text-size-adjust is
   pinned; this must apply outside the width media query so landscape phones
   (which exceed 720px wide) are covered too. */
html.dsh-native-mobile-active { -webkit-text-size-adjust:100%; text-size-adjust:100%; }
@media (max-width:720px) {
  html.dsh-native-mobile-active,html.dsh-native-mobile-active body { width:100%; height:100%; overflow:hidden; }
  html.dsh-native-mobile-active { --dsh-mobile-motion-duration:200ms; --dsh-mobile-motion-ease:cubic-bezier(.22,1,.36,1); }
  html.dsh-native-mobile-active :is(a,button,[role="button"],[role="tab"],[tabindex]) { -webkit-tap-highlight-color:transparent; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [role="treeitem"] { -webkit-tap-highlight-color:transparent; touch-action:manipulation; }
  html.dsh-native-mobile-active[data-dsh-mobile-input="touch"] :is(a,button,[role="button"],[role="tab"],[tabindex]):focus { outline:none !important; }
  html.dsh-native-mobile-active [role="tooltip"] { display:none !important; }
  /* Touch has no persistent hover affordance: keep workspace rows neutral after a tap. */
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] { --dsw-alias-interactive-bg-hover:transparent !important; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [role="treeitem"]:is(:hover,:active,:focus,[aria-selected="true"]),
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_sessionRow"][class*="_selected"],
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_searchResultRow"][class*="_selected"] { background:transparent !important; outline:0 !important; box-shadow:none !important; }
  /* Sidebar row menus are hover-only on desktop. Touch has no hover, so keep
     the ellipsis action visible and give it a reliable hit target. */
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_rowActions"] { display:inline-flex !important; align-items:center !important; gap:8px !important; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_sessionRow"] [class*="_time"] { display:none !important; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_rowActions"] button { box-sizing:border-box !important; width:32px !important; min-width:32px !important; height:32px !important; min-height:32px !important; }
  [data-dsh-mobile-frame] { grid-template-columns:0 minmax(0,1fr) 0 !important; width:100% !important; height:100dvh !important; overflow:hidden !important; }
  [data-dsh-mobile-center] { grid-column:2 !important; width:100vw !important; min-width:0 !important; }
  [data-dsh-mobile-center] > * { min-width:0 !important; }
  [data-dsh-mobile-header] { box-sizing:border-box !important; width:calc(100% - 16px) !important; margin:0 8px !important; min-width:0; padding-top:max(4px,env(safe-area-inset-top)) !important; padding-right:8px !important; padding-left:42px !important; }
  [data-dsh-mobile-header] [class*="_titleRow"] { box-sizing:border-box !important; display:flex !important; align-items:center !important; min-width:0; min-height:32px !important; height:32px !important; gap:6px !important; padding:0 6px !important; }
  [data-dsh-mobile-header] [class*="_titleCluster"] { min-width:0; }
  [data-dsh-mobile-header] [class*="_crumbs"] { min-width:0; overflow:hidden; }
  [data-dsh-mobile-header] [class*="_crumb"] { max-width:46vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  [data-dsh-mobile-header] [class*="_headerActions"] { min-width:0; overflow-x:auto; scrollbar-width:none; }
  [data-dsh-mobile-header] [class*="_headerActions"]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-header] [class*="_headerUtilities"] { gap:2px !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"] { width:40px; min-width:40px; padding:0 !important; overflow:hidden; color:transparent; font-size:0 !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"] > * { display:none !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"]::after { color:var(--dsw-text, #171a21); content:"日志"; font-size:11px; font-weight:600; }
  [data-dsh-mobile-header] [class*="_tabs"] { box-sizing:border-box !important; width:max-content !important; max-width:calc(100% - 58px) !important; min-height:28px !important; height:28px !important; margin-top:0 !important; padding-left:6px !important; padding-right:6px !important; overflow-x:auto; scrollbar-width:none; }
  [data-dsh-mobile-header] [class*="_tab"] { padding-bottom:5px !important; }
  [data-dsh-mobile-header] [class*="_tabs"]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-sidebar] { position:fixed !important; z-index:240 !important; inset:0 auto 0 0 !important; width:0 !important; overflow:visible !important; }
  [data-dsh-mobile-sidebar-root] { position:fixed !important; z-index:241 !important; inset:max(env(safe-area-inset-top),0px) auto 0 0 !important; height:auto !important; transition:width 180ms var(--dsh-mobile-motion-ease),box-shadow 180ms ease !important; }
  [data-dsh-mobile-sidebar][data-open="true"] [data-dsh-mobile-sidebar-root] { width:min(88vw,340px) !important; padding-top:0 !important; box-shadow:18px 0 46px rgb(15 23 42 / 18%); }
  [data-dsh-mobile-sidebar][data-open="true"] [data-dsh-mobile-sidebar-root] [class*="_logoRow"] { height:52px !important; padding:4px 0 4px 4px !important; margin-bottom:4px !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] { width:0 !important; border:0 !important; background:transparent !important; box-shadow:none !important; overflow:visible !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :not(:has([data-dsh-mobile-toggle])) { display:none !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :has([data-dsh-mobile-toggle]) { position:fixed !important; z-index:244 !important; top:env(safe-area-inset-top) !important; left:0 !important; box-sizing:border-box !important; width:50px !important; height:52px !important; padding:4px !important; border:0 !important; background:transparent !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :has([data-dsh-mobile-toggle]) > :not([data-dsh-mobile-toggle]) { display:none !important; }
  [data-dsh-mobile-toggle] { width:44px !important; height:44px !important; min-width:44px !important; min-height:44px !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-toggle] > svg[class*="_railFish"] { transform:translateY(-4px) !important; }
  .dsh-native-mobile-backdrop { position:fixed; z-index:235; inset:env(safe-area-inset-top) 0 0; border:0; background:rgb(15 23 42 / 32%); }
  .dsh-native-mobile-backdrop:not([hidden]) { animation:dsh-mobile-fade-in var(--dsh-mobile-motion-duration) ease-out; }
  .dsh-native-mobile-backdrop[hidden] { display:none; }
  [data-dsh-mobile-details] { position:fixed !important; z-index:250 !important; inset:0 0 0 auto !important; width:min(94vw,460px) !important; max-width:none !important; transform:translateX(100%); transition:transform var(--dsh-mobile-motion-duration) var(--dsh-mobile-motion-ease); background:var(--dsw-bg, #fff); box-shadow:-18px 0 46px rgb(15 23 42 / 18%); }
  [data-dsh-mobile-details][data-open="true"] { transform:translateX(0); }
  [data-dsh-mobile-handle] { display:none !important; }
  [data-dsh-mobile-settings] { flex-direction:column !important; width:100vw !important; height:100dvh !important; max-width:none !important; border-radius:0 !important; animation:dsh-mobile-panel-in var(--dsh-mobile-motion-duration) var(--dsh-mobile-motion-ease); }
  [data-dsh-mobile-settings-nav] { flex:none !important; width:100% !important; padding:max(14px,env(safe-area-inset-top)) 12px 8px !important; gap:10px !important; border-bottom:1px solid var(--dsw-alias-border-subtle,#e8ebef); }
  [data-dsh-mobile-settings-nav] [class*="_navTitle"] { padding:0 8px !important; font-size:18px !important; line-height:28px !important; }
  [data-dsh-mobile-settings-list] { flex-direction:row !important; gap:4px !important; overflow-x:auto !important; scrollbar-width:none; }
  [data-dsh-mobile-settings-list]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-settings-list] [class*="_navCell"] { flex:0 0 auto !important; min-width:max-content !important; height:44px !important; padding:10px 12px !important; }
  [data-dsh-mobile-settings-list] [aria-current="true"] { border-color:transparent !important; outline:0 !important; box-shadow:none !important; }
  [data-dsh-mobile-settings-content] { flex:1 1 auto !important; width:100% !important; min-height:0 !important; }
  [data-dsh-mobile-settings-header] { height:48px !important; min-height:48px !important; padding:10px 12px 6px !important; }
  [data-dsh-mobile-settings-header] [class*="_close"] { width:36px !important; height:36px !important; }
  [data-dsh-mobile-settings-options] { box-sizing:border-box !important; width:100% !important; padding:4px 16px max(24px,env(safe-area-inset-bottom)) !important; overflow-x:hidden !important; }
  [data-dsh-mobile-settings-options] > * { width:100% !important; min-width:0 !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] > [class*="_row"] { flex-direction:column !important; align-items:stretch !important; gap:12px !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_rowText"] { width:100% !important; padding-right:0 !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_selector"] { box-sizing:border-box !important; align-self:flex-start !important; justify-content:space-between !important; min-width:0 !important; min-height:44px !important; max-width:100% !important; }
  [data-dsh-mobile-settings-options] :is(input,select,textarea,button) { max-width:100%; }
  [data-dsh-mobile-settings-options] :is(input,select,textarea) { box-sizing:border-box; width:100%; min-width:0; }
  [data-dsh-mobile-settings-options] [class*="_head"] { min-width:0; flex-wrap:wrap; }
  /* Provider names may shrink, but their edit/delete actions remain horizontal
     and retain a full touch target on narrow screens. */
  [data-dsh-mobile-settings-options] [class*="_rowHead"]:has(> [class*="_rowIdentity"]) { flex-wrap:nowrap !important; align-items:center !important; }
  [data-dsh-mobile-settings-options] [class*="_rowIdentity"] { flex:1 1 auto !important; min-width:0 !important; overflow:hidden !important; }
  [data-dsh-mobile-settings-options] [class*="_rowName"] { min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-settings-options] [class*="_rowActions"] { flex:0 0 auto !important; flex-wrap:nowrap !important; width:max-content !important; min-width:max-content !important; max-width:none !important; }
  [data-dsh-mobile-settings-options] [class*="_rowActions"] button { flex:none !important; width:auto !important; min-width:44px !important; max-width:none !important; min-height:44px !important; padding-inline:10px !important; white-space:nowrap !important; word-break:keep-all !important; writing-mode:horizontal-tb !important; }
  [data-dsh-mobile-settings-content][data-dsh-mobile-view-transition="true"],
  [data-dsh-mobile-view][data-dsh-mobile-view-transition="true"] { animation:dsh-mobile-view-in var(--dsh-mobile-motion-duration) var(--dsh-mobile-motion-ease); }
  [data-dsh-mobile-center] textarea { font-size:16px !important; }
  /* Markdown tables use content-sized columns. Small tables fill the phone;
     wider tables keep readable cells and scroll inside their own region. */
  [data-dsh-mobile-table-scroll] { box-sizing:border-box; width:100%; max-width:100%; overflow-x:auto; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; }
  [data-dsh-mobile-table-scroll] table { display:table !important; width:max-content !important; min-width:100% !important; max-width:none !important; table-layout:auto !important; }
  [data-dsh-mobile-table-scroll] :is(th,td) { box-sizing:border-box; min-width:8ch; max-width:32ch; overflow-wrap:anywhere; word-break:break-word; vertical-align:top; }
  [data-dsh-mobile-center] pre { max-width:100%; overflow-x:auto; }
  [data-dsh-mobile-center] :is(img,video,canvas,svg) { max-width:100%; }
  [data-dsh-mobile-message-scroll] { box-sizing:border-box !important; width:100% !important; padding:8px 10px 20px !important; }
  [data-dsh-mobile-history-loader] { position:relative !important; min-height:1px !important; }
  [data-dsh-mobile-history-loader] button:not(:disabled) { position:absolute !important; width:1px !important; height:1px !important; margin:-1px !important; padding:0 !important; clip-path:inset(50%) !important; opacity:0 !important; overflow:hidden !important; pointer-events:none !important; }
  [data-dsh-mobile-history-loader] button:disabled { min-height:28px !important; padding:4px 12px !important; }
  [data-dsh-mobile-message-column] { box-sizing:border-box !important; width:100% !important; max-width:none !important; margin:0 !important; padding:0 !important; gap:10px !important; }
  [data-dsh-mobile-message-column] > * { width:100% !important; max-width:100% !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] { box-sizing:border-box !important; display:grid !important; grid-template-columns:16px minmax(0,1fr) !important; grid-auto-rows:auto !important; align-items:center !important; column-gap:6px !important; width:100% !important; height:auto !important; min-height:40px !important; padding:4px 0 !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > [class*="_leading"] { grid-column:1 !important; grid-row:1 !important; margin-right:0 !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > [class*="_title"] { grid-column:2 !important; grid-row:1 !important; min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > :is([class*="_sep"],[class*="_separator"]) { display:none !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > :is([class*="_summary"],[class*="_fileLink"]) { grid-column:2 !important; grid-row:2 !important; width:100% !important; min-width:0 !important; max-width:100% !important; overflow:hidden !important; line-height:19px !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > [class*="_summarySuffix"] { grid-column:2 !important; grid-row:3 !important; margin-left:0 !important; }
  [data-dsh-mobile-message-column] [data-context-fields] > * { display:grid !important; grid-template-columns:minmax(72px,30%) minmax(0,1fr) !important; gap:4px 10px !important; }
  [data-dsh-mobile-message-column] [class*="_ioSection"] { grid-template-columns:1fr !important; row-gap:4px !important; }
  [data-dsh-mobile-message-column] [class*="_body"] { max-width:100% !important; overflow-wrap:anywhere; }
  [data-dsh-mobile-center] [data-composer-card] ~ [class*="_root"],
  [data-dsh-mobile-center] [data-composer-card] ~ * [class*="_root"] { box-sizing:border-box !important; width:100% !important; max-width:100% !important; margin-bottom:-6px !important; padding:3px 4px 0 !important; font-size:11px !important; line-height:18px !important; white-space:normal !important; overflow:visible !important; text-overflow:clip !important; }
  [data-dsh-mobile-center] [data-composer-card] ~ [class*="_root"] [class*="_sep"],
  [data-dsh-mobile-center] [data-composer-card] ~ * [class*="_root"] [class*="_sep"] { margin:0 6px !important; }
  /* Message runtime details are inline on desktop. Give the clock/runtime
     label its own wrapping row on narrow screens so TTFT and throughput do
     not push the action buttons or clip at the viewport edge. */
  [data-dsh-mobile-center] [class*="_actions"]:has(> [class*="_timeStart"]),
  [data-dsh-mobile-center] [class*="_actions"]:has(> [class*="_timeEnd"]) { box-sizing:border-box !important; width:100% !important; flex-wrap:wrap !important; justify-content:flex-end !important; height:auto !important; min-height:28px !important; row-gap:2px !important; }
  [data-dsh-mobile-center] [class*="_timeStart"],
  [data-dsh-mobile-center] [class*="_timeEnd"] { box-sizing:border-box !important; flex:1 1 100% !important; order:2 !important; min-width:0 !important; max-width:100% !important; padding:0 !important; line-height:20px !important; text-align:center !important; white-space:normal !important; overflow-wrap:anywhere !important; }
  [data-dsh-mobile-center] [class*="_timeStart"] { box-sizing:border-box !important; flex:1 1 100% !important; order:2 !important; min-width:0 !important; max-width:100% !important; padding:0 !important; line-height:20px !important; text-align:center !important; white-space:normal !important; overflow-wrap:anywhere !important; }
  [data-dsh-mobile-center] [class*="_timeStart"] [class*="_runTimeDot"],
  [data-dsh-mobile-center] [class*="_timeEnd"] [class*="_runTimeDot"] { margin:0 6px !important; }
  /* Keep the context meter's legend rows as readable label/value pairs.
     Generic mobile flex rules can otherwise place the rows side by side and
     break Chinese labels in the middle of a word. */
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"],
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] { width:min(264px,calc(100vw - 32px)) !important; min-width:0 !important; max-width:calc(100vw - 32px) !important; }
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"] [class*="_rows"],
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] [class*="_rows"] { display:block !important; }
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"] [class*="_rows"] > [class*="_row"],
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] [class*="_rows"] > [class*="_row"] { display:flex !important; align-items:center !important; justify-content:space-between !important; width:100% !important; min-width:0 !important; white-space:nowrap !important; }
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"] :is(dt,dd),
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] :is(dt,dd) { white-space:nowrap !important; word-break:keep-all !important; }
  .dsh-mobile-branch-toast { position:fixed; z-index:300; top:max(12px,env(safe-area-inset-top)); left:50%; max-width:calc(100vw - 32px); box-sizing:border-box; padding:7px 14px; border:1px solid rgb(15 23 42 / 10%); border-radius:999px; background:rgb(15 23 42 / 92%); color:#fff; font-size:13px; line-height:20px; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0; pointer-events:none; transform:translate(-50%,-8px); transition:opacity 160ms ease,transform 160ms ease; }
  .dsh-mobile-branch-toast[data-visible="true"] { opacity:1; transform:translate(-50%,0); }
  [data-dsh-mobile-center] [class*="_composer"] { padding-left:8px !important; padding-right:8px !important; padding-bottom:max(8px,env(safe-area-inset-bottom)) !important; }
  /* The desktop composer intentionally wraps whole toolbar groups. On a phone,
     dynamic model and status labels made that row alternate between one and
     two lines. Keep two stable columns and let only the model label shrink. */
  [data-dsh-mobile-composer-row] { display:grid !important; grid-template-columns:max-content minmax(0,1fr) !important; align-items:center !important; gap:4px 8px !important; }
  [data-dsh-mobile-composer-tools] { display:flex !important; flex-wrap:nowrap !important; width:max-content !important; min-width:0 !important; max-width:max-content !important; gap:6px !important; }
  [data-dsh-mobile-composer-trailing] { display:flex !important; flex-wrap:nowrap !important; width:100% !important; min-width:0 !important; max-width:100% !important; gap:6px !important; margin-left:0 !important; justify-content:flex-end !important; }
  [data-dsh-mobile-composer-model] { flex:1 1 0 !important; width:auto !important; min-width:0 !important; max-width:none !important; }
  [data-dsh-mobile-composer-model-trigger] { box-sizing:border-box !important; width:100% !important; max-width:100% !important; min-width:0 !important; padding-left:6px !important; padding-right:4px !important; }
  [data-dsh-mobile-composer-model-label] { flex:1 1 auto !important; max-width:none !important; min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-center] [class*="_root"]:has(> [class*="_card"] textarea) { box-sizing:border-box !important; width:100% !important; padding:0 0 8px !important; }
  [data-dsh-mobile-center] [class*="_root"]:has(> [class*="_card"] textarea) > [class=""]:last-child { display:none !important; }
}
@keyframes dsh-mobile-fade-in { from { opacity:0; } }
@keyframes dsh-mobile-panel-in { from { opacity:.72; transform:translateY(6px); } }
@keyframes dsh-mobile-view-in { from { opacity:.58; transform:translateY(5px); } }
@media (max-width:420px) {
  [data-dsh-mobile-header] [class*="_headerActions"] { max-width:42vw; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_selector"] { align-self:stretch !important; width:100% !important; }
  [data-dsh-mobile-message-column] [data-context-fields] > * { grid-template-columns:1fr !important; }
}
@media (prefers-reduced-motion:reduce) {
  [data-dsh-mobile-sidebar-root],[data-dsh-mobile-details] { transition:none !important; }
  .dsh-native-mobile-backdrop:not([hidden]),[data-dsh-mobile-settings],
  [data-dsh-mobile-settings-content][data-dsh-mobile-view-transition="true"],
  [data-dsh-mobile-view][data-dsh-mobile-view-transition="true"] { animation:none !important; }
}
/* Touch feedback: taps must give an immediate, perceivable response. The
   stock app relies on :hover, which touch has no persistent form of, so we
   add :active feedback here. Sidebar rows keep their deliberate neutral
   background handling above; opacity/transform still give them feedback.
   role=treeitem rows (the session list) are plain divs, so they are matched
   explicitly. */
html.dsh-native-mobile-active :is(a,button,[role="button"],[role="tab"],[role="treeitem"],label,[tabindex],[contenteditable]):active {
  opacity:.72 !important;
  transform:scale(.97) !important;
  filter:brightness(.95) !important;
}
/* Prevent iOS auto-zoom when a field with a small font receives focus: any
   field under 16px triggers it, which reads as "the page suddenly gets big".
   The composer is a contenteditable div, so it must be covered too. */
html.dsh-native-mobile-active :is(input,textarea,select,[contenteditable]) { font-size:16px !important; }
/* Kill the double-tap-zoom affordance and the 300ms tap delay everywhere. */
html.dsh-native-mobile-active :is(a,button,[role="button"],[role="tab"],[role="treeitem"],[tabindex]) { touch-action:manipulation !important; }
/* The right details/explorer toggle sits directly beside the session-log
   button in the narrow header; reserve room so the two never overlap. */
html.dsh-native-mobile-active [data-dsh-mobile-header] [class*="_sessionLogButton"] { margin-right:48px !important; }
/* In portrait the workbench panel (Files / terminal) would otherwise fill the
   whole screen; present it as a right-side drawer at the same ratio as the
   left sidebar, FULL-HEIGHT like the native panel. The app's own toggle
   buttons are floated above the drawer (like the left sidebar's floating
   toggle), so opening and closing both go through the button — consistent
   with the desktop layout. */
@media (orientation: portrait) {
  html.dsh-native-mobile-active [data-dsh-mobile-workbench] {
    position:fixed !important;
    inset:0 0 0 auto !important;
    z-index:250 !important;
    width:min(88vw,340px) !important;
    height:100dvh !important;
    max-width:none !important;
    transform:translateX(100%) !important;
    transition:transform var(--dsh-mobile-motion-duration,200ms) var(--dsh-mobile-motion-ease,cubic-bezier(.22,1,.36,1)) !important;
    background:var(--dsw-bg,#fff) !important;
    box-shadow:-18px 0 46px rgb(15 23 42 / 18%) !important;
    overflow:auto !important;
  }
  html.dsh-native-mobile-active [data-dsh-mobile-workbench]:not([class*="_panelHidden"]) { transform:translateX(0) !important; }
  /* The workbench toggle cluster shares its stacking context with the panel
     (both live inside [data-dsh-panel-host], z-index:25), so it only needs a
     z-index ABOVE the drawer's 250 to stay clickable on top of it. It is
     NOT moved in the DOM — moving it would detach it from the app's React
     portal click handler. */
  html.dsh-native-mobile-active [class*="_toggleCluster"] {
    position:fixed !important;
    top:max(4px,env(safe-area-inset-top)) !important;
    right:8px !important;
    z-index:260 !important;
    display:flex !important;
    align-items:center !important;
    justify-content:center !important;
    gap:4px !important;
  }
}
/* Landscape phones are short: the sidebar's fixed header + footer squeeze the
   session list to a couple of rows, and forcing overflow:visible on the list
   disables its native scroll. Reclaim the height by dropping the secondary
   footer actions and compressing the logo row, then keep the list scrollable
   (native overflow:auto). Settings stay reachable via the kept settingsArea. */
@media (max-height:520px) and (orientation: landscape) {
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_footerActions"] {
    display:none !important;
  }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_logoRow"] {
    height:44px !important;
    min-height:44px !important;
  }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_list"]:not([class*="_listArea"]) {
    overflow-y:auto !important;
    min-height:0 !important;
    -webkit-overflow-scrolling:touch !important;
  }
}
`

/* Locate the native mobile surface so it can be installed without re-reading the layout. */

function classToken(element: Element, suffix: string): boolean {
  return Array.from(element.classList).some(value => value.endsWith(suffix))
}

function firstByClassSuffix(root: ParentNode, suffix: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('[class]')).find(element => classToken(element, suffix))
}

const AUTO_HISTORY_THRESHOLD_PX = 64

/** Whether a user-driven scroll moved upward into the automatic history-loading zone. */
export function shouldAutoLoadEarlier(previousTop: number, currentTop: number): boolean {
  return currentTop <= AUTO_HISTORY_THRESHOLD_PX && currentTop < previousTop - 0.5
}

/** Interactive roles that act inside a sidebar row instead of selecting it. */
const ROW_CONTROL_SELECTOR = 'button,[role="button"],[role="menu"],[aria-haspopup]'

/**
 * Whether a programmatic focus is the composer editor this layer has to mute.
 *
 * The stock app focuses the composer when a session opens, which pops the iOS
 * keyboard. Only that field is guarded: blurring any other programmatic focus
 * broke the model menu, whose search field opens focused when the user drills
 * into the model list — the blur fired the menu's own blur handler and closed
 * the overlay the user had just opened.
 * @param target - The element receiving focus.
 * @returns Whether the focus should be dropped unless the user asked for it.
 */
export function isComposerEditorFocus(target: Element): boolean {
  if (!target.matches('[contenteditable]:not([contenteditable="false"])')) return false
  return target.closest('[data-composer-card]') !== null
}

/**
 * Whether a sidebar click selected the row itself rather than one of the row's
 * own controls or an expand/collapse toggle.
 *
 * Collapsing the sidebar after a row selection is a portrait affordance, but a
 * row also hosts its action controls (the ellipsis menu, add-session). Treating
 * those as a selection collapsed the sidebar right after the menu opened, which
 * tore the menu down and read as a jump into the conversation.
 *
 * A Workspace (project) header is also a `role="treeitem"`, but its click
 * expands or collapses the session list nested beneath it instead of opening a
 * session. Only an expandable row announces `aria-expanded`, and a session row
 * never carries it, so that attribute is what separates a toggle from a
 * selection. Without this check, opening a project collapsed the drawer 240ms
 * later and read as jumping into one of its sessions.
 * @param target - Event target inside the row.
 * @param row - The enclosing `role="treeitem"` row.
 * @returns Whether the click should be treated as a row selection.
 */
export function selectsSidebarRow(target: Element, row: Element): boolean {
  if (row.getAttribute('aria-expanded') !== null) return false
  const action = target.closest(ROW_CONTROL_SELECTOR)
  return action === null || action === row
}

/**
 * Whether a press inside an open choice menu must keep focus where it is.
 *
 * The stock model menu autofocuses its search field and closes itself from the
 * *container's* own blur handler. On touch, tapping a model row dispatches
 * `mousedown`, whose default action moves focus out of the container, so the
 * menu unmounts before `mouseup` — no `click` is ever dispatched, the row's
 * handler never runs, and no request is sent. Picking a model on the phone
 * therefore did nothing at all: no error, no toast, and an unchanged label,
 * while the identical tap through a synthetic `click` (which never dispatches
 * `mousedown`) selected the model correctly.
 *
 * Cancelling only the `mousedown` default keeps focus inside the container, so
 * no blur fires and the menu stays mounted, while `click` still arrives.
 * Cancelling `touchstart` or `pointerdown` instead would suppress the very
 * click this is meant to deliver.
 * @param menu - The enclosing `[role="menu"]`, or null when the press is outside every menu.
 * @param row - The menu item under the press.
 * @param active - The currently focused element.
 * @returns Whether the press default must be cancelled.
 */
export function preservesMenuFocus(
  menu: Element | null,
  row: Element | null,
  active: Element | null,
): boolean {
  if (menu === null || row === null) return false
  return active !== null && menu.contains(active)
}

/** The menu item roles the stock model menu renders its rows with. */
const MENU_ITEM_SELECTOR = '[role="menuitemradio"],[role="menuitem"]'

/** The search field the stock model pane autofocuses when it opens. */
const MENU_SEARCH_SELECTOR = 'input[type="search"],input[role="searchbox"]'

/**
 * Whether a focus belongs to the search field of an open choice menu.
 *
 * Drilling into the model list autofocuses this field, and on a phone that
 * raises the soft keyboard, which shrinks the visual viewport from 796px to
 * 516px and pushes the model rows out of easy reach. Suppressing the keyboard
 * with `inputMode: none` keeps the focus — so the menu's own blur handler never
 * fires and the overlay stays mounted — while leaving the list fully visible.
 * @param target - The element receiving focus.
 * @returns Whether this is the menu search field whose keyboard should be muted.
 */
export function isMenuSearchFocus(target: Element): boolean {
  if (!target.matches(MENU_SEARCH_SELECTOR)) return false
  return target.closest('[role="menu"]') !== null
}

/** Add mobile semantics without replacing feature trees. */
export function installNativeMobileSurface(): () => void {
  document.documentElement.classList.add('dsh-native-mobile-active')
  const setInputMode = (mode: 'keyboard' | 'touch'): void => {
    document.documentElement.dataset.dshMobileInput = mode
  }
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') setInputMode('touch')
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab' || event.key.startsWith('Arrow')) setInputMode('keyboard')
  }
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  // Guard against programmatic field focus: the stock app focuses the
  // composer when a session opens, which pops the iOS keyboard. In touch mode,
  // only keep focus that came from a real tap on the field itself.
  let lastPointerTarget: Element | undefined
  const onPointerDownForFocus = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') {
      lastPointerTarget = event.target instanceof Element ? event.target : undefined
    }
  }
  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (!isComposerEditorFocus(target)) return
    if (document.documentElement.dataset.dshMobileInput !== 'touch') return
    const tapped = lastPointerTarget !== undefined
      && (target === lastPointerTarget || target.contains(lastPointerTarget))
    lastPointerTarget = undefined
    if (tapped) return
    requestAnimationFrame(() => {
      if (document.activeElement === target) target.blur()
    })
  }
  document.addEventListener('pointerdown', onPointerDownForFocus, true)
  document.addEventListener('focusin', onFocusIn, true)
  // Keep focus inside an open choice menu so its own blur handler cannot tear
  // the overlay down before the row's click is dispatched. See
  // {@link preservesMenuFocus} for the failure this prevents.
  const onMenuMouseDown = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const menu = event.target.closest('[role="menu"]')
    if (menu === null) return
    const row = event.target.closest(MENU_ITEM_SELECTOR)
    if (!preservesMenuFocus(menu, row, document.activeElement)) return
    event.preventDefault()
  }
  document.addEventListener('pointerdown', onMenuMouseDown, true)
  // Mute the soft keyboard the model pane's autofocused search field would
  // raise, without letting go of the focus that keeps the overlay mounted.
  // Tapping the field on purpose restores normal input so search still works.
  let lastSearchPointerTarget: Element | undefined
  const onSearchPointerDown = (event: PointerEvent): void => {
    lastSearchPointerTarget = event.target instanceof Element ? event.target : undefined
  }
  const onMenuSearchFocusIn = (event: FocusEvent): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (!isMenuSearchFocus(target)) return
    // Only a phone raises a soft keyboard. On a desktop browser reaching this
    // page over the LAN, the field must be left exactly as it is — the same
    // touch-mode gate the composer guard above uses. Opening the menu is always
    // a touch here, so the phone path is unaffected.
    if (document.documentElement.dataset.dshMobileInput !== 'touch') return
    const tapped = lastSearchPointerTarget !== undefined
      && (target === lastSearchPointerTarget || target.contains(lastSearchPointerTarget))
    lastSearchPointerTarget = undefined
    if (tapped) {
      if (target.inputMode === 'none') target.inputMode = ''
      return
    }
    target.inputMode = 'none'
  }
  document.addEventListener('pointerdown', onSearchPointerDown, true)
  document.addEventListener('focusin', onMenuSearchFocusIn, true)
  const backdrop = document.createElement('button')
  backdrop.type = 'button'
  backdrop.className = 'dsh-native-mobile-backdrop'
  backdrop.hidden = true
  backdrop.setAttribute('aria-label', '关闭工作区导航')
  document.body.append(backdrop)
  const branchToast = document.createElement('div')
  branchToast.className = 'dsh-mobile-branch-toast'
  branchToast.setAttribute('role', 'status')
  branchToast.setAttribute('aria-live', 'polite')
  document.body.append(branchToast)
  let branchToastTimer = 0
  const showBranchToast = (): void => {
    const header = document.querySelector<HTMLElement>('[data-dsh-mobile-header]')
    const title = header === null ? undefined : header.querySelector<HTMLElement>('[class*="_crumbCurrent"]')?.textContent?.trim()
    branchToast.textContent = title === undefined ? '当前分支' : `当前分支：${title}`
    branchToast.dataset.visible = 'true'
    if (branchToastTimer !== 0) window.clearTimeout(branchToastTimer)
    branchToastTimer = window.setTimeout(() => {
      branchToast.removeAttribute('data-visible')
      branchToastTimer = 0
    }, 1600)
  }
  const onBranchClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const branch = event.target.closest<HTMLButtonElement>('button[aria-label*="分支"],button[aria-label*="Branch"],button[aria-label*="branch"]')
    if (branch === null || branch.hasAttribute('disabled') || branch.getAttribute('aria-disabled') === 'true') return
    window.setTimeout(showBranchToast, 80)
  }
  document.addEventListener('click', onBranchClick, true)
  // In portrait, selecting a session from the sidebar should collapse the
  // sidebar automatically: it would otherwise cover most of the screen while
  // the user reads the opened conversation.
  const onSidebarSessionSelect = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    if (window.innerHeight <= window.innerWidth) return
    const tree = event.target.closest<HTMLElement>('[data-dsh-mobile-sidebar] [role="treeitem"]')
    if (tree === null) return
    if (!selectsSidebarRow(event.target, tree)) return
    const sidebarEl = tree.closest<HTMLElement>('[data-dsh-mobile-sidebar]')
    if (sidebarEl === null || sidebarEl.getAttribute('data-open') !== 'true') return
    const sidebarToggle = document.querySelector<HTMLButtonElement>('[data-dsh-mobile-toggle]')
    if (sidebarToggle === null) return
    window.setTimeout(() => {
      if (sidebarToggle.isConnected && sidebarToggle.getAttribute('aria-expanded') !== 'false') sidebarToggle.click()
    }, 240)
  }
  document.addEventListener('click', onSidebarSessionSelect, true)
  let frame: HTMLElement | undefined
  let sidebar: HTMLElement | undefined
  let sidebarRoot: HTMLElement | undefined
  let toggle: HTMLButtonElement | undefined
  let viewArea: HTMLElement | undefined
  let scheduled = 0
  let transitionFrame = 0
  let transitionRestartFrame = 0
  let transitionTimer = 0
  let transitionTarget: HTMLElement | undefined
  let historyScroller: HTMLElement | undefined
  let historyPreviousTop = 0
  const historyLoadButton = (): HTMLButtonElement | undefined => {
    const loader = historyScroller === undefined ? undefined : firstByClassSuffix(historyScroller, '_older')
    return loader?.querySelector<HTMLButtonElement>('button') ?? undefined
  }
  const onHistoryScroll = (): void => {
    if (historyScroller === undefined) return
    const currentTop = Math.max(0, historyScroller.scrollTop)
    const shouldLoad = shouldAutoLoadEarlier(historyPreviousTop, currentTop)
    historyPreviousTop = currentTop
    if (!shouldLoad) return
    const button = historyLoadButton()
    if (button === undefined || button.disabled || button.getAttribute('aria-disabled') === 'true') return
    button.click()
  }
  const bindHistoryScroller = (next: HTMLElement | undefined): void => {
    if (historyScroller === next) return
    historyScroller?.removeEventListener('scroll', onHistoryScroll)
    historyScroller = next
    historyPreviousTop = next?.scrollTop ?? 0
    historyScroller?.addEventListener('scroll', onHistoryScroll, { passive: true })
  }
  const animateNavigation = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const trigger = event.target.closest<HTMLElement>('button,a,[role="tab"],[aria-selected]')
    if (trigger === null || trigger.hasAttribute('disabled') || trigger.getAttribute('aria-disabled') === 'true') return
    if (trigger.getAttribute('aria-selected') === 'true' || trigger.getAttribute('aria-current') === 'true') return
    const settingsNavigation = trigger.closest('[data-dsh-mobile-settings-list]') !== null
    const conversationNavigation = trigger.matches('[role="tab"]')
    const sidebarNavigation = trigger.closest('[data-dsh-mobile-sidebar-root]') !== null
      && trigger.closest('[data-dsh-mobile-toggle]') === null
    if (!settingsNavigation && !conversationNavigation && !sidebarNavigation) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (transitionFrame !== 0) cancelAnimationFrame(transitionFrame)
    if (transitionRestartFrame !== 0) cancelAnimationFrame(transitionRestartFrame)
    transitionFrame = requestAnimationFrame(() => {
      transitionFrame = 0
      const target = settingsNavigation
        ? document.querySelector<HTMLElement>('[data-dsh-mobile-settings-content]')
        : viewArea
      if (target === null || target === undefined) return
      transitionTarget?.removeAttribute('data-dsh-mobile-view-transition')
      target.removeAttribute('data-dsh-mobile-view-transition')
      transitionRestartFrame = requestAnimationFrame(() => {
        transitionRestartFrame = 0
        transitionTarget = target
        target.dataset.dshMobileViewTransition = 'true'
        if (transitionTimer !== 0) clearTimeout(transitionTimer)
        transitionTimer = window.setTimeout(() => {
          target.removeAttribute('data-dsh-mobile-view-transition')
          if (transitionTarget === target) transitionTarget = undefined
          transitionTimer = 0
        }, 240)
      })
    })
  }
  document.addEventListener('click', animateNavigation)

  const sync = (): void => {
    scheduled = 0
    const dedicatedCenter = document.querySelector<HTMLElement>('.dshm-main') ?? undefined
    // Only the stock layout module ships `_frame` *and* `_centerCol`. Other DSH
    // modules (chat TurnNavigator, attachment, plan-review, subagent) also ship
    // `*_frame` classes, and inside the dedicated shell the conversation hosts
    // one of them first — so a bare class probe picks that node, `_centerCol` is
    // nowhere below it, and `center` falls into the `center === undefined` return
    // that silently skips every DOM adaptation below (history paging included).
    const stockFrame = dedicatedCenter === undefined ? firstByClassSuffix(document, '_frame') : undefined
    frame = stockFrame !== undefined && firstByClassSuffix(stockFrame, '_centerCol') !== undefined
      ? stockFrame
      : undefined
    if (frame !== undefined) frame.dataset.dshMobileFrame = 'true'
    sidebar = frame === undefined
      ? document.querySelector<HTMLElement>('.dshm-drawer') ?? undefined
      : firstByClassSuffix(frame, '_sidebarCol')
    const center = frame === undefined ? dedicatedCenter : firstByClassSuffix(frame, '_centerCol')
    const details = frame === undefined ? undefined : firstByClassSuffix(frame, '_detailsCol')
    const handle = frame === undefined ? undefined : firstByClassSuffix(frame, '_handle')
    // Tag the workbench panel (Files explorer / terminal) precisely so the
    // mobile CSS can turn it into a right-side drawer in portrait. The outer
    // panel's class token ends with exactly `_panel`; the inner panelBody
    // ends with `_panelBody`, so match the token boundary.
    const workbench = firstByClassSuffix(document, '_workbench')
    const isPanelToken = (element: Element): boolean =>
      Array.from(element.classList).some(token => /_panel$/u.test(token))
    let workbenchPanel: HTMLElement | null | undefined = workbench?.parentElement
    while (workbenchPanel !== null && workbenchPanel !== undefined && !isPanelToken(workbenchPanel)) {
      workbenchPanel = workbenchPanel.parentElement
    }
    if (workbenchPanel !== null && workbenchPanel !== undefined) {
      workbenchPanel.dataset.dshMobileWorkbench = 'true'
      // The workbench toggle cluster and the panel are BOTH children of the
      // same [data-dsh-panel-host] (a fixed, viewport-sized, z-index:25
      // containing block appended to document.body). They share one stacking
      // context, so a higher z-index on the cluster is enough to float it
      // above the full-height drawer — no DOM move needed. Moving the cluster
      // out of its React portal would detach it from the app's synthetic
      // click handler, which is exactly what broke the toggle earlier.
    }
    if (center === undefined) {
      bindHistoryScroller(undefined)
      return
    }
    if (center !== undefined) {
      center.dataset.dshMobileCenter = 'true'
      center.querySelector<HTMLElement>('header')?.setAttribute('data-dsh-mobile-header', 'true')
      viewArea = firstByClassSuffix(center, '_viewArea')
      if (viewArea !== undefined) viewArea.dataset.dshMobileView = 'true'
      const conversation = center.querySelector<HTMLElement>('[data-conversation-scroll]')
      bindHistoryScroller(conversation ?? undefined)
      const historyLoader = conversation === null ? undefined : firstByClassSuffix(conversation, '_older')
      if (historyLoader !== undefined) {
        historyLoader.dataset.dshMobileHistoryLoader = 'true'
        historyLoader.setAttribute('aria-live', 'polite')
        const button = historyLoader.querySelector<HTMLButtonElement>('button')
        if (button !== null) {
          button.tabIndex = -1
          if (button.disabled) button.removeAttribute('aria-hidden')
          else button.setAttribute('aria-hidden', 'true')
        }
      }
      const messageColumn = conversation === null ? undefined : firstByClassSuffix(conversation, '_column')
      const messageScroll = messageColumn?.parentElement
      if (messageColumn !== undefined && messageScroll !== null && messageScroll !== undefined && classToken(messageScroll, '_scroll')) {
        messageColumn.dataset.dshMobileMessageColumn = 'true'
        messageScroll.dataset.dshMobileMessageScroll = 'true'
      }
      for (const table of center.querySelectorAll<HTMLTableElement>('table')) {
        const parent = table.parentElement
        if (parent?.dataset.dshMobileTableScroll === 'true') continue
        const wrapper = document.createElement('div')
        wrapper.dataset.dshMobileTableScroll = 'true'
        table.before(wrapper)
        wrapper.append(table)
      }
      const composerCard = center.querySelector<HTMLElement>('[data-composer-card]')
      const composerRow = composerCard?.querySelector<HTMLElement>(':scope > [data-input-scroll]')?.nextElementSibling
      if (composerRow instanceof HTMLElement) {
        composerRow.dataset.dshMobileComposerRow = 'true'
        const groups = Array.from(composerRow.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
        const composerTools = groups[0]
        const composerTrailing = groups.at(-1)
        if (composerTools !== undefined) composerTools.dataset.dshMobileComposerTools = 'true'
        if (composerTrailing !== undefined && composerTrailing !== composerTools) {
          composerTrailing.dataset.dshMobileComposerTrailing = 'true'
          const modelTrigger = composerTrailing.querySelector<HTMLButtonElement>('button[aria-label^="选择模型"],button[aria-label^="Select model"]')
          if (modelTrigger !== null) {
            modelTrigger.dataset.dshMobileComposerModelTrigger = 'true'
            modelTrigger.parentElement?.setAttribute('data-dsh-mobile-composer-model', 'true')
            modelTrigger.querySelector<HTMLElement>('[class*="_triggerLabel"]')?.setAttribute('data-dsh-mobile-composer-model-label', 'true')
          }
        }
      }
    }
    if (handle !== undefined) handle.dataset.dshMobileHandle = 'true'
    if (details !== undefined) {
      details.dataset.dshMobileDetails = 'true'
      const lastColumn = frame?.style.gridTemplateColumns.trim().split(/\s+/).at(-1)
      details.dataset.open = String(lastColumn !== undefined && lastColumn !== '0px' && lastColumn !== '0')
    }
    const settings = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(dialog => {
      const directNav = Array.from(dialog.children).find(child => child instanceof HTMLElement && classToken(child, '_nav'))
      return directNav !== undefined
    })
    if (settings !== undefined) {
      settings.dataset.dshMobileSettings = 'true'
      const nav = Array.from(settings.children).find(child => child instanceof HTMLElement && classToken(child, '_nav')) as HTMLElement | undefined
      const content = Array.from(settings.children).find(child => child instanceof HTMLElement && classToken(child, '_content')) as HTMLElement | undefined
      if (nav !== undefined) {
        nav.dataset.dshMobileSettingsNav = 'true'
        firstByClassSuffix(nav, '_navList')?.setAttribute('data-dsh-mobile-settings-list', 'true')
      }
      if (content !== undefined) {
        content.dataset.dshMobileSettingsContent = 'true'
        firstByClassSuffix(content, '_header')?.setAttribute('data-dsh-mobile-settings-header', 'true')
        firstByClassSuffix(content, '_options')?.setAttribute('data-dsh-mobile-settings-options', 'true')
      }
    }
    if (sidebar === undefined) return
    sidebar.dataset.dshMobileSidebar = 'true'
    toggle = firstByClassSuffix(sidebar, '_toggle') as HTMLButtonElement | undefined
    let candidate = toggle?.parentElement
    while (candidate !== undefined && candidate !== null && candidate !== sidebar && !classToken(candidate, '_root')) candidate = candidate.parentElement
    sidebarRoot = candidate !== sidebar && candidate !== null ? candidate : undefined
    if (sidebarRoot === undefined) return
    sidebarRoot.dataset.dshMobileSidebarRoot = 'true'
    for (const brand of sidebarRoot.querySelectorAll<HTMLElement>('[class*="_fallbackBrandName"]')) {
      if (brand.textContent?.trim() === 'DSH Local Build') brand.textContent = 'DeepSeek Harness'
    }
    if (toggle !== undefined) toggle.dataset.dshMobileToggle = 'true'
    const collapsed = classToken(sidebarRoot, '_collapsed')
    sidebar.dataset.open = String(!collapsed)
    backdrop.hidden = collapsed
  }
  const schedule = (): void => { if (scheduled === 0) scheduled = requestAnimationFrame(sync) }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'disabled'] })
  backdrop.addEventListener('click', () => { if (sidebar?.dataset.open === 'true') toggle?.click() })
  sync()
  return () => {
    observer.disconnect()
    document.removeEventListener('click', onBranchClick, true)
    document.removeEventListener('click', onSidebarSessionSelect, true)
    document.removeEventListener('pointerdown', onPointerDownForFocus, true)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('mousedown', onMenuMouseDown, true)
    document.removeEventListener('pointerdown', onSearchPointerDown, true)
    document.removeEventListener('focusin', onMenuSearchFocusIn, true)
    if (branchToastTimer !== 0) window.clearTimeout(branchToastTimer)
    branchToast.remove()
    if (scheduled !== 0) cancelAnimationFrame(scheduled)
    if (transitionFrame !== 0) cancelAnimationFrame(transitionFrame)
    if (transitionRestartFrame !== 0) cancelAnimationFrame(transitionRestartFrame)
    if (transitionTimer !== 0) clearTimeout(transitionTimer)
    transitionTarget?.removeAttribute('data-dsh-mobile-view-transition')
    historyScroller?.removeEventListener('scroll', onHistoryScroll)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('click', animateNavigation)
    backdrop.remove()
    document.documentElement.classList.remove('dsh-native-mobile-active')
    delete document.documentElement.dataset.dshMobileInput
  }
}
