# Changelog

Notable changes to DSH Mobile are recorded here. GitHub Releases remain the source for downloadable packages and complete generated commit notes.

## 0.3.5

- **The mobile settings ordering had silently stopped running.** `orderAuthenticatedSettings` located this plugin's boot-manifest entry by the literal id `dsh-mobile`, but the entry id is the published package name (`dsh-mobile-tailscale`). The lookup found nothing and returned early, so the code that orders the authenticated settings module after this plugin never executed; DSH then resolved its settings to the in-memory backend on every mobile page, which surfaced as "settings are unavailable in this browser" and an unloadable model provider directory. The id is now derived from `package.json` (and the `tsdown` module-loader banner reads the same source), the stale requirement that the settings module depend on `connection` was dropped — DSH 0.1.2 moved its one-time `$host.isLoopback` read and declares only `@deepseek-ai/dsh-api-remotes` — and the test fixtures now match the real manifest shape, so a future drift fails a test instead of silently skipping the work.
- **The remote channel never rewrote its document.** `serveRewrittenDocument` gated the rewrite on a declared `Content-Length`, but DSH answers the application document with `Transfer-Encoding: chunked`, so every request skipped the rewrite. The body is now buffered to a bound instead, and a non-identity `Content-Encoding` skips the rewrite rather than feeding compressed bytes to a parser. A rewrite failure still serves the stock document, so the remote channel degrades instead of failing closed.
- **Opening the composer model menu closed it again.** The programmatic-focus guard meant to stop the iOS keyboard from popping on session open blurred *any* non-tapped text field. Drilling into the model list autofocuses its search field, so that blur fired the menu's own blur handler and dismissed the overlay; the sibling "推理等级" pane, which has no search field, was unaffected. The guard now covers only the composer editor it was written for.
- **A sidebar row's action menu was torn down by the row's own tap.** The portrait auto-collapse treated a tap on a row's ellipsis menu as selecting the row and collapsed the sidebar 240ms later, taking the just-opened menu with it. Only a row-body selection collapses the sidebar now, matching the guard the dedicated layout already had.
- **The "移动访问" entry shared a footer row with other plugins' entries** and was pushed past the sidebar edge, where the resize divider clipped it. The footer action row is allowed to wrap and this entry claims its own line, with its icon and label centered together.
- **The Android bridge's interactive actions cannot succeed.** `startPending` answers `files.pick` and `camera.capture` synchronously with `{ok:false, code:"pending"}`, and the page adapter rejects and forgets any non-`ok` reply, so the real asynchronous reply is dropped. Recorded here rather than changed: the fix needs a device to verify against.
- **Selecting a model on the phone did nothing.** The authenticated-transport trust was installed too late to survive DSH's own memoization. `@deepseek-ai/dsh-client-connection` builds its handle with `isLoopback: transport?.ownsHost === true || <loopback hostname>`; this plugin instead let `isLoopback` default to `false` on the phone and flipped it from the mobile client module's `apply()`. But `@deepseek-ai/dsh-api-gateway` snapshots `isLoopback` into cached `$host` facts keyed **only** on `home`, which is stable on the remote channel — so whichever module read `ctx.remote.$host` first froze `isLoopback: false` for the life of the page, and `dsh-client-ui-settings`, `dsh-client-ui-settings-general` and `dsh-api-session-controller` all read that cached value. The plugin now injects the pre-boot `window.__DSH_TRANSPORT__ = { ownsHost: true }` override that upstream ships, so the handle is born loopback-trusted on both channels, and `@deepseek-ai/dsh-api-gateway` is ordered after the mobile client on the remote-backed settings graph — both halves of the upstream 0.3.4 fix, which this fork had dropped while keeping only the settings edge. The injected statement deliberately does not throw when an override already exists: it shares a script block with the boot-manifest assignment, so throwing would blank the whole mobile page.

- **Tapping a model row on the phone sent no request at all.** A finger tap dispatches `mousedown`, whose default action moves focus out of the menu container — and that container closes itself from its own blur handler. It therefore unmounted between `mousedown` and `mouseup`, no `click` was ever dispatched, and the row's handler never ran: no request, no error, no toast, unchanged label. Only the deepest level broke because the model pane autofocuses its search field, while drilling from one root-pane cell to the other keeps focus *inside* the container and never blurs it — and a synthetic `click` (which dispatches no `mousedown`) always worked. `native-mobile.ts` now cancels just the `mousedown` default for a press on a menu item while focus is inside that item's menu, keeping the overlay mounted so the click gets through; cancelling `touchstart` or `pointerdown` instead would suppress the very click being delivered. Verified on the device against the emitted page, the RPC frames, and the host's own `session/modelCatalog` and `settings.yaml`.

## 0.3.4

- Export `isSupportedDshVersion` and `warnUnsupportedDshVersion` from the package root alongside the existing `assertSupportedDshVersion`, so the whole compatibility gate is reachable from the public API. No behavior change: activation already used the non-throwing path added in 0.3.3.
- Add `0.1.2-rc.1` to the `@deepseek-ai/*` peer ranges so the declared compatibility set matches `SUPPORTED_DSH_VERSIONS` (and `check:dsh-compatibility`, which reads those ranges as the verified set).
- Add [TROUBLESHOOTING.md](TROUBLESHOOTING.md): the recorded diagnostic chain for the Safe Mode brick, the `ERR_PNPM_UNEXPECTED_STORE` / ignored `pnpm.overrides` install hazard, the `ready`-but-unreachable remote channel, and generation peer validation.

## 0.3.3

- **An unverified Host version no longer aborts activation.** `assertSupportedDshVersion` threw from the first statement of `apply()`, so a version outside the verified set failed its loader entry, failed the whole plugin tree, and made DSH Desktop stop the harness and fall back to its safe-mode profile with **every** third-party plugin disabled. Activation now warns (`DSH_MOBILE_UNVERIFIED_DSH_VERSION`) and continues; the strict assert remains available for callers that want it.
- **Verified against DeepSeek Harness `0.1.2-rc.1`** (DSH Desktop 0.8.2). The frontend boot contract was unchanged: the bundled layout module's `dsh.client.inject` still matches the renderer-v2 dependency profile exactly.
- **Fix a 30-day timer overflow on the remote channel.** The pairing-free remote guest authorization used a 30-day (`2 592 000 000 ms`) expiry, and the derived abort/close delays were passed straight to `setTimeout`, which truncates any delay above `2^31 - 1 ms` (~24.85 days) to **1 ms**. Every remote request and WebSocket was therefore aborted immediately, logging `TimeoutOverflowWarning` and `upstream_unavailable (socket hang up)` in the harness log. Session-derived delays are now clamped to `MAX_TIMER_DELAY_MS`.

## 0.3.2 - 2026-08-29

- **Remote channel no longer hardcodes the web port.** Tailscale Serve now targets a plugin-owned loopback passthrough proxy that resolves the live upstream from the host `webServer` service per request (falling back to `DSH_WEB_URL`, then `upstreamOrigin`). The remote channel follows DSH Desktop's random per-launch web port automatically — no manual `tailscale serve` re-pointing after restarts.
- **Browser-trust fence bypass for remote.** The passthrough proxy rewrites `Host`/`Origin` to the upstream origin (the same proven pattern as the LAN gateway) and injects the upstream session cookie, so phone `/api` calls no longer hit the DSH browser-trust fence 403 while staying pairing-free.
- **Automatic stale serve-config recovery.** Starting Serve now detects a port-443 occupancy (`already serving TCP` etc.), clears it when 443 is the only serve entry, and retries once; a conflict with other serve entries surfaces a dedicated `serve_port_conflict` error instead of the generic `serve_failed`.
- **LAN gateway upstream follows the live instance too.** Both LAN and remote paths resolve the upstream through the webServer service, so neither depends on a fixed port being occupied by a particular instance.
- **Transparent WebSocket passthrough.** The proxy forwards every upgrade request (any path, query preserved) instead of whitelisting three core channels, so plugin channels such as `/sidebar/ws/agent-opens` and `/sidebar/ws/agent-terminals` keep working remotely. Upgrade failures now log a diagnostic line to the harness log instead of being masked as an EOF.
- **Pairing-free mobile-frontend assets on the remote path.** The DSH WebServer mirrors the LAN gateway's mobile metadata, custom css/js, mobile layout module and extension registry (without the LAN device-pairing requirement), so the phone's mobile UI features load over the Tailscale Serve channel too.

## 0.3.1 - 2026-08-28

- Credit @BlueandwhiteXD ([#15](https://github.com/saya-ch/dsh-mobile/pull/15)) for the Android keyboard inset report and fix incorporated into the 0.3 mobile layout.

## 0.3.0 - 2026-08-28

- Add one-click connection diagnostics for versions, LAN gateway, network interface, Windows firewall, and the selected remote provider, with a sanitized report for support requests.
- Publish compatibility metadata separately from the stable discovery protocol so the Android app can distinguish app, plugin, and protocol mismatches.
- Keep the connection chooser interactive during background restoration, race saved LAN and remote trust, reuse trust after remote address changes, apply remote-aware timeouts and single-flight refresh backoff, and privately cache revisioned assets for faster reopening.
- Preserve fallback discovery when Android 13+ nearby Wi-Fi permission is declined, and provide concise guidance for QR, pairing, session, rate-limit, and service failures.
- Forward authenticated DSH and plugin mutations with CSRF protection, restoring mobile plugin-market and other non-GET actions.
- Coordinate Android and Web status-bar and safe-area behavior, keep settings actions readable on narrow screens, and refresh the app icon.
- Support DeepSeek Harness 0.1.2-alpha.1, including its `/api/remote.mux` state channel and batched renderer boot, so Workspaces, model selection, sessions, and community plugins remain available on mobile.
- Compress dedicated mobile boot batches and harden Android WebView origin checks, reducing remote startup transfer while avoiding background-thread WebView access.

## 0.2.2 - 2026-08-27

- Detect LAN and remote pairing links automatically after a QR scan, independent of the currently selected connection page.
- Clarify QR, network, firewall, certificate, and pairing failures so users can identify the shortest recovery path.

## 0.2.1 - 2026-08-25

- Add a stable Android app download entry to the desktop Mobile Access panel.

## 0.2.0 - 2026-08-24

- Add independent LAN and remote access flows with separate paired-device stores.
- Add optional Tailscale Funnel and managed cpolar remote providers.
- Restore saved Android connections automatically and improve mobile loading over limited links.
- Page older session history on demand and compress eligible gateway responses.
- Build the pinned Funnel host from source and publish checksums, an SBOM, and third-party notices.

## 0.1.4 - 2026-08-23

- Keep the plugin compatible with DeepSeek Harness 0.1.1.
- Continue mobile layout, safe-area, composer, settings, and interaction improvements.
- Restore bounded native response reads on Android 10 through 12.
- Publish Android releases as reproducible, signed release builds instead of temporary debug builds.
- Preserve the existing mobile protocol so older app builds can continue using the updated plugin; switching from the previous temporary Android signature requires one uninstall and re-pair.
- Refresh CI actions, Android lint coverage, build tooling, and maintenance documentation.

## 0.1.3 - 2026-08-23

- Added DeepSeek Harness 0.1.1 compatibility.
- Improved mobile layout and interaction behavior.
