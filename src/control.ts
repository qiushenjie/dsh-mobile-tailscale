import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { restrictPrivateFile } from './private-file.js'

/** Versioned durable preference for the resident mobile-access runtime. */
export interface MobileAccessControlState {
  readonly version: 1
  readonly enabled: boolean
}

/** Persistence seam for the runtime preference. */
export interface MobileAccessControlStore {
  load(): Promise<MobileAccessControlState>
  save(state: MobileAccessControlState): Promise<void>
}

/** One started gateway runtime owned by the controller. */
export function parseMobileAccessControlState(value: unknown): MobileAccessControlState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('mobile-access control state must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.enabled !== 'boolean'
    || Reflect.ownKeys(record).some(key => key !== 'version' && key !== 'enabled')) {
    throw new Error('mobile-access control state has an unsupported format')
  }
  return Object.freeze({ version: 1, enabled: record.enabled })
}

/** Atomic JSON store whose absent-file state comes from the installation-time default. */
export class JsonMobileAccessControlStore implements MobileAccessControlStore {
  constructor(private readonly file: string, private readonly initiallyEnabled: boolean) {}

  async load(): Promise<MobileAccessControlState> {
    let stat
    try {
      stat = await lstat(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return Object.freeze({ version: 1, enabled: this.initiallyEnabled })
      }
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
      throw new Error('mobile-access control state must be a regular file no larger than 4 KiB')
    }
    await restrictPrivateFile(this.file)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
    } catch (error) {
      throw new Error('mobile-access control state is not valid JSON', { cause: error })
    }
    return parseMobileAccessControlState(parsed)
  }

  async save(state: MobileAccessControlState): Promise<void> {
    const validated = parseMobileAccessControlState(state)
    const directory = dirname(this.file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      const current = await lstat(this.file)
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new Error('mobile-access control state target must remain a regular file')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = join(directory, `.${basename(this.file)}.${randomBytes(12).toString('hex')}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(validated)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporary, this.file)
      await restrictPrivateFile(this.file)
    } catch (error) {
      try {
        await rm(temporary, { force: true })
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'control state write and temporary cleanup both failed')
      }
      throw error
    }
  }
}

/** Serialized persistent lifecycle for the gateway behind the always-loaded Cordis entry. */
