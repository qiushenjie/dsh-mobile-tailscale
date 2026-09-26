import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  JsonMobileAccessControlStore,
  parseMobileAccessControlState,
  type MobileAccessControlState,
} from '../src/control.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function controlFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-control-'))
  temporaryDirectories.push(directory)
  return join(directory, 'nested', 'control.json')
}

describe('mobile-access control state', () => {
  it('uses the installation default only for a missing file and persists a disabled restart', async () => {
    const file = await controlFile()
    const store = new JsonMobileAccessControlStore(file, true)

    await expect(store.load()).resolves.toEqual({ version: 1, enabled: true })
    await store.save({ version: 1, enabled: false })
    await expect(new JsonMobileAccessControlStore(file, true).load()).resolves.toEqual({ version: 1, enabled: false })

    const initiallyOff = await controlFile()
    await expect(new JsonMobileAccessControlStore(initiallyOff, false).load())
      .resolves.toEqual({ version: 1, enabled: false })
  })

  it('rejects malformed or extended durable state', async () => {
    const file = await controlFile()
    const store = new JsonMobileAccessControlStore(file, false)
    await store.save({ version: 1, enabled: false })
    await writeFile(file, '{"version":1,"enabled":false,"extra":true}\n')
    await expect(new JsonMobileAccessControlStore(file, false).load()).rejects.toThrow(/unsupported format/)
  })

  it('rejects non-JSON durable state', async () => {
    const file = await controlFile()
    const store = new JsonMobileAccessControlStore(file, false)
    await store.save({ version: 1, enabled: false })
    await writeFile(file, 'not json')
    await expect(new JsonMobileAccessControlStore(file, false).load()).rejects.toThrow(/not valid JSON/)
  })

  it('parses only the exact control-state shape', () => {
    const parsed: MobileAccessControlState = parseMobileAccessControlState({ version: 1, enabled: true })
    expect(parsed).toEqual({ version: 1, enabled: true })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(() => parseMobileAccessControlState(null)).toThrow(/must be an object/)
    expect(() => parseMobileAccessControlState({ version: 2, enabled: true })).toThrow(/unsupported format/)
    expect(() => parseMobileAccessControlState({ version: 1, enabled: 'yes' })).toThrow(/unsupported format/)
    expect(() => parseMobileAccessControlState({ version: 1, enabled: true, extra: 1 })).toThrow(/unsupported format/)
  })
})
