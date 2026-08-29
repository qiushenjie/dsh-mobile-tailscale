import { describe, expect, it } from 'vitest'
import { assertSupportedDshVersion, SUPPORTED_DSH_VERSIONS } from '../src/compatibility.js'

describe('DeepSeek Harness compatibility', () => {
  it.each(SUPPORTED_DSH_VERSIONS)('accepts verified release %s', version => {
    expect(() => { assertSupportedDshVersion(version) }).not.toThrow()
  })

  it.each(['0.1.0-rc.4', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1', '0.1.2'])('rejects unverified release %s', version => {
    expect(() => { assertSupportedDshVersion(version) }).toThrow(/unsupported DeepSeek Harness version/u)
  })

  it('allows an unresolvable version (desktop bundles the host internally)', () => {
    expect(() => { assertSupportedDshVersion('unknown') }).not.toThrow()
    expect(() => { assertSupportedDshVersion(undefined) }).not.toThrow()
  })
})
