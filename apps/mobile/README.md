# DeepSeek Harness Android App

> **不再维护 / No longer maintained.** This Android WebView shell is abandoned. It is **not part of any supported flow**: as of plugin 0.4.0 the only way in is the Tailscale Serve address opened in a phone browser. The app source is kept in the repository for reference only; it is not built, released, or supported. The iOS client was only ever an unpublished local experiment.
>
> The app was designed around the local-network gateway, pairing links, and `dsh-mobile setup`, all of which were removed in 0.4.0. Nothing below is a working setup guide; it records what the app used to be.

[简体中文](README.zh-CN.md) · [Back to the project](../../README.en.md)

DeepSeek Harness was the display name of this lightweight, community-maintained Android WebView shell. It did not bundle a second DSH frontend: the app and a mobile browser loaded the same HTTPS origin, so both received the same DSH features plus live-editable `mobile.css` presentation and `mobile.js` functionality.

## What it used to do

- Load a DSH HTTPS origin with no browser address or tab bars.
- Navigate same-origin WebView history with the system Back button first.
- Use narrow native implementations for file selection, same-origin downloads, sharing, and site-data clearing.
- Expose a `dshMobile` bridge for `files.pick`, `camera.capture`, `share`, `clipboard.read`, and `clipboard.write`.

Its connection flow depended on the removed LAN channel: a `dsh-mobile setup` step, a pairing link or QR code from the desktop panel, a pinned self-signed CA, and DNS-SD/mDNS discovery on port `3443`. None of that exists anymore. The remote channel it also knew about — Tailscale Serve, with no pairing and tailnet membership as the access control — is the only channel the plugin now has.

A mobile browser is and always was a first-class alternative; the app was optional even when it was maintained.

## Build

The source is retained for historical reference. Requirements were Android Studio or Android SDK 36 and JDK 17; the repository includes the Gradle 8.11.1 Wrapper.

```powershell
Set-Location apps/mobile/android
./gradlew.bat :app:lintDebug :app:testDebugUnitTest :app:assembleDebug -x :app:lintAnalyzeDebugUnitTest -x :app:lintAnalyzeDebugAndroidTest
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. No supported release is published from this source any more.

## Acceptance

Shared URL-policy tests covered origin normalization, pairing entry, same-origin navigation, and download paths. Device acceptance used to cover small screens, landscape, cutouts and gestures, the keyboard, font scaling, valid and invalid TLS, file input, downloads, Back, rotation, and reauthentication after clearing data. None of this is an active commitment.

Apache-2.0 licensed. See [LICENSE](../../LICENSE).
