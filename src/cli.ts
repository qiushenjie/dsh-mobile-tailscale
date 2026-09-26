#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertExtensionId } from './extensions.js'

function dshHome(): string {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

async function createExtensionScaffold(root: string, id: string, name: string): Promise<void> {
  assertExtensionId(id)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = join(root, id)
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`extension directory already exists: ${id}`)
    throw error
  }
  const files: Readonly<Record<string, string>> = {
    'extension.json': `${JSON.stringify({ schemaVersion: 1, id, name, version: '0.1.0', description: '在手机端扩展 DSH' }, null, 2)}\n`,
    'host.mjs': `export default async function activate(api) {\n  api.action('hello', {\n    input: api.schema.object({ name: api.schema.string().max(80) }),\n    async run({ signal, deviceId }, input) {\n      void signal; void deviceId\n      return { message: \`Hello, \${input.name}\` }\n    },\n  })\n}\n`,
    'mobile.js': `window.dshMobile?.define?.({\n  apiVersion: 1,\n  id: '${id}',\n  activate(api) {\n    return api.ui.registerSurface({\n      id: '${id}-page', placement: 'page', label: ${JSON.stringify(name)},\n      mount(container) {\n        container.textContent = ${JSON.stringify(`这是 ${name} 的移动页面。`)}\n        return () => container.replaceChildren()\n      },\n    })\n  },\n})\n`,
    'mobile.css': `/* ${name.replaceAll('*/', '* /')} 的移动端样式。保存后通常会在几秒内刷新。 */\n`,
  }
  try {
    for (const [file, contents] of Object.entries(files)) await writeFile(join(directory, file), contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  console.log(`Created extension: ${directory}`)
}

async function extensionCommand(args: readonly string[]): Promise<void> {
  const [subcommand, id, ...rest] = args
  if (subcommand !== 'create' || id === undefined) throw new Error('usage: extension create <id> [--name <name>]')
  let name = id
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--name' && rest[index + 1] !== undefined) { name = rest[index + 1]!; index += 1; continue }
    throw new Error(`unknown extension option: ${rest[index] ?? ''}`)
  }
  if (name.length === 0 || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('--name is invalid')
  await createExtensionScaffold(join(dshHome(), 'mobile-access', 'extensions'), id, name)
}

async function purge(args: readonly string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== '--yes') throw new Error('purge requires --yes')
  await rm(join(dshHome(), 'mobile-access'), { recursive: true, force: true })
  console.log('Removed DSH Mobile preferences, custom Web files, and extensions.')
}

function help(): void {
  console.log([
    'dsh-mobile extension create <id> [--name <name>]',
    'dsh-mobile purge --yes',
    '',
    'Run through the DSH profile:',
    '  dsh plugin --profile web exec dsh-mobile extension create <id>',
  ].join('\n'))
}

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2)
  if (command === 'extension') await extensionCommand(args)
  else if (command === 'purge') await purge(args)
  else if (command === 'help' || command === '--help' || command === '-h') help()
  else throw new Error(`unknown command: ${command}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
