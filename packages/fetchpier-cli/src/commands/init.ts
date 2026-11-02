import { Command, Option } from 'commander'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { workspace } from '@fetchpier/core'
import { CliError } from '../errors'
import { EXIT } from '../exit-codes'

export type Template = 'rest' | 'graphql'

export interface InitOptions {
  /** Folder name to create (relative to cwd). Omit to init the current folder. */
  name?: string
  template?: Template
  cwd?: string
  write?: (s: string) => void
}

const STARTER: Record<Template, { file: string; content: string }> = {
  rest: {
    file: 'example.http',
    content: ['# Example request — edit or delete me', 'GET {{baseUrl}}/health', ''].join('\n')
  },
  graphql: {
    file: 'example.http',
    content: [
      '# Example GraphQL request — edit or delete me',
      'POST {{baseUrl}}/graphql',
      'Content-Type: application/json',
      '',
      '{ "query": "{ __typename }" }',
      ''
    ].join('\n')
  }
}

/** Write `content` to `path` only when no file is already there (never overwrite a seed). */
async function writeIfAbsent(path: string, content: string): Promise<void> {
  if (existsSync(path)) return
  await workspace.atomicWriteFile(path, content)
}

/**
 * Create a new Fetchpier workspace and return its absolute path. Delegates both
 * the layout **and** the `default` environment to `core.workspace.createWorkspace`
 * (shared with the desktop), then adds the starter request for the chosen
 * template. Fails cleanly (exit 4) if the target is already a workspace.
 */
export async function initWorkspace(options: InitOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd()
  const target = options.name ? resolve(cwd, options.name) : resolve(cwd)
  const template = options.template ?? 'rest'

  if (existsSync(join(target, '.fetchpier'))) {
    throw new CliError(EXIT.WORKSPACE, `A Fetchpier workspace already exists at ${target}`)
  }

  // REQ-0121: core owns the default environment for both adapters — `init` no
  // longer writes that file itself. Its own skip-if-taken rule keeps the
  // write-safety guarantee: a folder that already holds a `default` environment
  // but no workspace marker keeps it intact rather than being overwritten.
  await workspace.createWorkspace(target, { seedDefaultEnvironment: true })

  // The starter request is still the CLI's own: it is template-dependent, and the
  // desktop has no equivalent. Guarded by an existence check (REQ write-safety)
  // so a hand-authored `example.http` survives.
  const starter = STARTER[template]
  await writeIfAbsent(join(target, 'requests', starter.file), starter.content)

  const write = options.write ?? ((s) => process.stdout.write(s))
  write(`Created Fetchpier workspace at ${target}\n`)
  write(`  Next: fp run requests/${starter.file} --workspace ${options.name ?? '.'}\n`)
  return target
}

/** Register `fp init [name]`. */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('create a new Fetchpier workspace')
    .argument('[name]', 'folder to create (default: the current directory)')
    .addOption(
      new Option('--template <kind>', 'starter template')
        .choices(['rest', 'graphql'])
        .default('rest')
    )
    .action(async (name: string | undefined, opts: { template: Template }) => {
      await initWorkspace({ name, template: opts.template })
    })
}
