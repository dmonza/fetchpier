import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'

// Coverage for who publishes a release (CI-007).
//
// Run by CI from a tag, electron-builder publishes by default: with no `publish`
// block in `electron-builder.yml` it infers GitHub from `package.json`
// `repository` and uploads the installer itself. The build jobs have no
// GH_TOKEN and read-only contents — by design, since the `publish` job is the one
// that assembles the draft release from their artifacts — so that implicit upload
// failed the Windows build of the first tagged release with exit 1.
//
// Hence the rule this file pins: every packager call in the release workflow
// passes `--publish never`, and only the `publish` job may write to the
// repository. Text and YAML only — the defect surfaces on a tag push, the one
// event no local gate replays.

const WORKFLOW = resolve(__dirname, '..', '.github', 'workflows', 'release.yml')

interface Step {
  run?: string
}
interface Job {
  permissions?: Record<string, string>
  steps?: Step[]
}
interface Workflow {
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

const workflow = yaml.load(readFileSync(WORKFLOW, 'utf-8')) as Workflow

// A step packages when it calls electron-builder directly or through one of the
// `package[:platform]` npm scripts, which end in an electron-builder call.
const NPM_PACKAGE = /\bnpm run package(?::\w+)?\b/
const DIRECT = /\belectron-builder\b/

function packagerCalls(job: Job): string[] {
  return (job.steps ?? [])
    .map((step) => step.run ?? '')
    .flatMap((run) => run.split(/&&|\n/).map((part) => part.trim()))
    .filter((part) => NPM_PACKAGE.test(part) || DIRECT.test(part))
}

const buildJobs = Object.entries(workflow.jobs).filter(([name]) => name.startsWith('build-'))

describe('release workflow packaging', () => {
  it('builds an installer in each platform job', () => {
    expect(buildJobs.map(([name]) => name).sort()).toEqual([
      'build-linux',
      'build-macos',
      'build-windows'
    ])
    for (const [name, job] of buildJobs) {
      expect(packagerCalls(job), `${name} has no packager call`).not.toHaveLength(0)
    }
  })

  it('never lets electron-builder publish', () => {
    for (const [name, job] of buildJobs) {
      for (const call of packagerCalls(job)) {
        if (NPM_PACKAGE.test(call)) {
          // Without the `--` separator npm reads `--publish` as its own option
          // and the flag never reaches electron-builder.
          expect(call, `${name}: ${call}`).toMatch(/\s--\s(?:.*\s)?--publish never\b/)
        } else {
          expect(call, `${name}: ${call}`).toMatch(/\s--publish never\b/)
        }
      }
    }
  })

  it('grants write access to the repository only to the publish job', () => {
    expect(workflow.permissions?.contents).toBe('read')
    const writers = Object.entries(workflow.jobs)
      .filter(([, job]) => job.permissions?.contents === 'write')
      .map(([name]) => name)
    expect(writers).toEqual(['publish'])
  })
})
