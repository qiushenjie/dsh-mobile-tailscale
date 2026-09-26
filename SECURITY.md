# Security policy

`dsh-mobile` exposes a control surface that can run tools on the host computer. As of 0.4.0 there is exactly one way in: Tailscale Serve on the `https://<node>.<tailnet>.ts.net` address.

## Supported versions

Security fixes target the newest stable release. Prereleases receive fixes only when the corresponding GitHub Release says they are supported. The README compatibility table identifies the exact DSH release tested with each plugin version.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability-reporting form for `qiushenjie/dsh-mobile-tailscale`. Include the affected version, deployment topology, reproduction steps, and whether tailnet access or local access is required.

The maintainer will acknowledge a complete report within seven days. Publication timing is coordinated with the reporter after a fix and an upgrade path are available.

## Threat model

The trust boundary is **tailnet membership**. Tailscale Serve publishes the plugin's loopback passthrough proxy only to devices signed in to the same tailnet, and the `*.ts.net` name carries a publicly trusted (Let's Encrypt) certificate. There is no plugin-owned authentication step beyond that membership:

- There is **no LAN listener**. The plugin binds no `:3443` gateway, advertises nothing over DNS-SD/mDNS or UDP, and opens no port on the local network.
- There is **no pairing secret**. No pairing key, pairing link, QR code, device token, or device registry exists, and none is generated or stored.
- There is **no self-signed CA**. The former "DeepSeek Harness Mobile CA" chain and `$DSH_HOME/mobile-access/tls/` are gone; the plugin issues, stores, and trusts no certificate of its own.

Because access is membership, anyone who can join the tailnet can operate DSH on this computer with the desktop user's authority. Join only devices and users you trust, and remove a device from the tailnet when it is lost.

## Deployment requirements

- Keep the ordinary DSH Web listener on loopback.
- Expose the phone path only through Tailscale Serve. Do not enable Tailscale Funnel, and do not publish the node to the public internet.
- Keep Tailscale up to date on both the computer and the phone, and keep the phone signed in to the same tailnet.
- Turn the remote switch off when the phone path is not needed; that clears the plugin's own 443 serve entry and stops its loopback proxy.
- The plugin never requests or stores a Tailscale password, Auth Key, or OAuth secret. The 443 registration is cleared only while it still points at this instance's own loopback proxy, so a Desktop restart does not drop another process's registration.
- Resetting remote access clears the plugin's own remote state and leaves no plugin-owned remote credential behind.
- Treat anyone on the tailnet as a fully trusted operator: stock DSH methods reached through the loopback proxy may read configuration or run tools with the desktop user's authority.
- Treat `mobile.js` as application code with the page's same-origin authority. Restrict write access to trusted host-side DSH sessions and review generated API calls or browser-permission use.
- Treat every extension `host.mjs` as a local program with the desktop user's Node.js privileges. It is never sandboxed; only place code there that you trust.
- Extension Actions and Routes receive filtered request data and an abort signal. They cannot set proxy security headers or access the proxy's cookies, tokens, or internal request headers.
- The remote switch, reconnect, and reset admin endpoints accept only same-origin calls that satisfy the `sec-fetch-site` check; a non-local caller gets `403`.

## Known limitation

The current DSH HTML boot process contains inline JavaScript, revives Schemastery callbacks with `new Function`, and applies some styles dynamically. To keep the stock Web UI runnable, the proxy's Content Security Policy currently includes `script-src 'self' 'unsafe-inline' 'unsafe-eval'` and `style-src 'self' 'unsafe-inline'`. The remaining directives still restrict origins, connections, frames, objects, workers, images, and form targets, but this policy does not eliminate script-injection risk. Removing these allowances requires upstream DSH support for nonces, stable hashes, external boot resources, and a non-evaluating schema representation.

This repository never accepts private keys, npm tokens, pairing values, device credentials, Cookies, or captured settings in issues, logs, fixtures, or example configuration.
