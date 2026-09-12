# Changelog

Notable changes to DSH Mobile are recorded here. GitHub Releases remain the source for downloadable packages and complete generated commit notes.

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
