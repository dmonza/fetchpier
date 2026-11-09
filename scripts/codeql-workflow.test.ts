import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'

// CI-008 — the static security analysis is wired to run where the project needs
// it, with the least permissions it can have. Text and YAML only: a real run
// exists only on the code host.

interface Step {
  uses?: string
  with?: Record<string, unknown>
}
interface Job {
  permissions?: Record<string, string>
  steps: Step[]
}
interface Workflow {
  on: {
    push?: { branches?: string[] }
    pull_request?: { branches?: string[] }
    schedule?: { cron: string }[]
  }
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

const workflow = yaml.load(
  readFileSync(resolve(__dirname, '..', '.github', 'workflows', 'codeql.yml'), 'utf-8')
) as Workflow

const jobs = Object.values(workflow.jobs)
const steps = jobs.flatMap((job) => job.steps)
const init = steps.find((step) => step.uses?.includes('codeql-action/init'))

describe('static-analysis workflow', () => {
  it('runs on pushes to and pull requests into the default branch', () => {
    expect(workflow.on.push?.branches).toEqual(['main'])
    expect(workflow.on.pull_request?.branches).toEqual(['main'])
  })

  it('also runs weekly', () => {
    expect(workflow.on.schedule).toHaveLength(1)
    const [minute, hour, dayOfMonth, month, dayOfWeek] = workflow.on.schedule![0].cron.split(' ')
    expect([minute, hour]).not.toContain('*')
    expect([dayOfMonth, month]).toEqual(['*', '*'])
    expect(dayOfWeek).toMatch(/^[0-6]$/)
  })

  it('analyzes JavaScript and TypeScript', () => {
    expect(init?.with?.languages).toBe('javascript-typescript')
  })

  it('pairs initialization with analysis', () => {
    expect(steps.some((step) => step.uses?.includes('codeql-action/analyze'))).toBe(true)
  })

  it('reads the repository and writes only security events', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    for (const job of jobs) {
      expect(job.permissions).toEqual({ contents: 'read', 'security-events': 'write' })
    }
  })

  it('leaves test code out of the analysis', () => {
    const config = yaml.load(String(init?.with?.config)) as { 'paths-ignore': string[] }
    expect(config['paths-ignore']).toEqual(expect.arrayContaining(['test', '**/*.test.ts']))
  })
})
