# Third-party notices

DSH Mobile includes a small Windows helper built from the source in `native/funnel-host`. The helper uses [Tailscale tsnet](https://pkg.go.dev/tailscale.com/tsnet) `v1.102.3`, distributed under the BSD 3-Clause license. Its exact transitive Go module versions are recorded in `native/funnel-host/go.mod` and `native/funnel-host/go.sum`; each dependency remains subject to its own license.

The optional cpolar component is not included in the npm package. When a user explicitly chooses cpolar installation, DSH Mobile downloads the pinned official archive shown in the UI, verifies its size and SHA-256 digest, and stores it only under the user's DSH Mobile data directory. cpolar remains subject to its [terms of service](https://www.cpolar.com/tos).
