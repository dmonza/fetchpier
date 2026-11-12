/**
 * REQ-0108 — the unshared variable row in the environment editor.
 *
 * An *unshared* variable holds a local value with no entry in the shared environment
 * file. These cases assert it is an ordinary row (ENV-UNSHARED-001..005 in the test
 * catalog): marked, fully actionable, not draggable, and materialized only by the two
 * gestures on its own line.
 *
 * The ordering/serialization rules themselves live in `lib/environment-variables.ts`
 * and are proven there — this file asserts only what needs the rendered editor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Environment, EnvironmentLocalView } from '../../../shared/types'

// The drag widget is a lazily-loaded wrapper around a third-party library whose
// positioning reads element rectangles — which this DOM environment reports as
// zero, so a real drag cannot be driven here. What belongs to this component is
// the *wiring* of its reorder callback, so the widget is substituted by a stub
// that exposes that callback directly.
vi.mock('../ui/SortableRows', () => ({
  default: ({
    rows,
    onReorder
  }: {
    rows: { id: string; node: React.ReactNode }[]
    onReorder: (ids: string[]) => void
  }) => (
    <div>
      <button
        aria-label="test-reorder"
        onClick={() => onReorder([...rows].reverse().map((r) => r.id))}
      />
      {rows.map((r) => (
        <div key={r.id}>{r.node}</div>
      ))}
    </div>
  )
}))

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { EnvironmentEditorModal, EnvironmentManager } from './EnvironmentManager'
import { useEnvironmentStore } from '../../stores/environment'
import { useSecretsStore } from '../../stores/secrets'
import { useToastStore } from '../../stores/toast'
import { useCookieStore } from '../../stores/cookies'

const ENV: Environment = {
  id: 'dev',
  folder: 'dev',
  name: 'dev',
  variables: { apiKey: 'shared-key' }
}

/** `baseUrl` is unshared: a local value with no entry in the shared file. */
function view(overrides: Partial<EnvironmentLocalView> = {}): EnvironmentLocalView {
  return {
    environmentId: 'dev',
    rows: [
      {
        name: 'apiKey',
        sharedKind: 'plain',
        hasLocalOverride: false,
        localOnly: false,
        orphan: false,
        invalid: false,
        divergent: false
      },
      {
        name: 'baseUrl',
        sharedKind: 'absent',
        hasLocalOverride: true,
        localOnly: true,
        orphan: false,
        invalid: false,
        divergent: false,
        localDisplay: 'http://localhost:9200'
      }
    ],
    ...overrides
  }
}

let save: ReturnType<typeof vi.fn>
let clearLocal: ReturnType<typeof vi.fn>

function stubApi(): void {
  save = vi.fn().mockResolvedValue(undefined)
  clearLocal = vi.fn().mockResolvedValue(undefined)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    secrets: {
      // `status`, not `getStatus` — the preload surface is `secrets.status`
      // (src/preload/index.ts). With the stale name the component's mount effect
      // threw `window.api.secrets.status is not a function`, was swallowed by its
      // `.catch(console.error)`, and left the store's status permanently `null`,
      // so every assertion below ran against the unresolved state by accident.
      status: vi
        .fn()
        .mockResolvedValue({ hasManifest: false, unlocked: false, backend: 'os-keychain' })
    },
    environment: { save },
    localValues: {
      getView: vi.fn().mockResolvedValue(view()),
      set: vi.fn().mockResolvedValue(undefined),
      clear: clearLocal,
      seed: vi.fn().mockResolvedValue(undefined),
      reveal: vi.fn().mockResolvedValue(''),
      onChanged: vi.fn(() => () => undefined)
    }
  }
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<EnvironmentEditorModal onClose={() => undefined} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  // Radix portals the dialog to document.body.
  return { container: document.body, root }
}

/** The row whose name cell holds `name` (rows are the grid containers inside the dialog). */
function row(container: HTMLElement, name: string): HTMLElement {
  const cell = [...container.querySelectorAll('span')].find(
    (s) => s.textContent === name && s.className.includes('truncate')
  )
  if (!cell) throw new Error(`no row for ${name}`)
  return cell.closest('.group') as HTMLElement
}

function inputs(el: HTMLElement): HTMLInputElement[] {
  return [...el.querySelectorAll('input')] as HTMLInputElement[]
}

beforeEach(() => {
  stubApi()
  useEnvironmentStore.setState({
    environments: [ENV],
    activeEnvironmentId: 'dev',
    baselines: { dev: { ...ENV.variables } }
  })
  useSecretsStore.setState({
    status: { hasManifest: false, unlocked: false, backend: 'os-keychain' }
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the environment selector (ENV-ROW-012)', () => {
  it('lists the environments alphabetically, not in the order the store holds them', async () => {
    useEnvironmentStore.setState({
      environments: [
        { id: 'id-s', folder: 'staging', name: 'Staging', variables: {} },
        { id: 'id-p', folder: 'produccion', name: 'Producción', variables: {} },
        { id: 'id-d', folder: 'dev-qa', name: 'Dev QA', variables: {} }
      ],
      activeEnvironmentId: 'id-s',
      baselines: {}
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<EnvironmentManager />)
    })

    const options = [...container.querySelectorAll('option')].map((o) => o.textContent)
    // The first entry is the "no environment" placeholder.
    expect(options).toEqual(['environment.noEnvironment', 'Dev QA', 'Producción', 'Staging'])
    act(() => root.unmount())
  })
})

describe('unshared variable row', () => {
  it('renders as an ordinary marked row with every action and no drag handle', async () => {
    const { container, root } = await mount()

    const unshared = row(container, 'baseUrl')
    // Marked: the leading accent bar, plus the tooltip that carries the meaning
    // without relying on colour.
    expect(unshared.querySelector('.bg-primary')).not.toBeNull()
    expect(unshared.textContent).toContain('environment.local.unsharedTooltip')

    // The Shared cell is editable — the row is no longer a dead end.
    const sharedCell = inputs(unshared).find(
      (i) => i.getAttribute('aria-label') === 'environment.local.sharedColumn'
    )
    expect(sharedCell).toBeDefined()
    expect(sharedCell?.readOnly).toBe(false)
    expect(sharedCell?.value).toBe('')
    // Its placeholder is what a user self-discovering actually reads: it names the
    // state and the gesture without any hover. The accent bar makes the row findable;
    // it does not explain it.
    expect(sharedCell?.placeholder).toBe('environment.local.unsharedPlaceholder')

    // The Sync check is rendered and operable, unchecked.
    const sync = inputs(unshared).find((i) => i.type === 'checkbox')
    expect(sync).toBeDefined()
    expect(sync?.checked).toBe(false)
    expect(sync?.disabled).toBe(false)

    // Both row actions are present.
    const labels = [...unshared.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(labels).toContain('secrets.makeSecret')
    expect(labels).toContain('keyValue.remove')
    // …and no drag handle, because the row has no slot in the shared file yet.
    expect(labels).not.toContain('keyValue.dragHandle')

    await act(async () => root.unmount())
  })

  it('gives the variable to the team when the Shared cell is committed, keeping the local override', async () => {
    const { container, root } = await mount()
    const sharedCell = inputs(row(container, 'baseUrl')).find(
      (i) => i.getAttribute('aria-label') === 'environment.local.sharedColumn'
    )!

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!
      setter.call(sharedCell, 'https://team.example.com')
      sharedCell.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      // React maps onBlur to the bubbling `focusout`, not to `blur`.
      sharedCell.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })

    expect(save).toHaveBeenCalledOnce()
    const saved = save.mock.calls[0][0] as Environment
    expect(saved.variables.baseUrl).toBe('https://team.example.com')
    // The name lands after the variables already in the shared file.
    expect(Object.keys(saved.variables)).toEqual(['apiKey', 'baseUrl'])
    // The local override is untouched — the value still wins on this machine.
    expect(clearLocal).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('does not write anything when an untouched Shared cell is blurred', async () => {
    const { container, root } = await mount()
    const sharedCell = inputs(row(container, 'baseUrl')).find(
      (i) => i.getAttribute('aria-label') === 'environment.local.sharedColumn'
    )!

    await act(async () => {
      // React maps onBlur to the bubbling `focusout`, not to `blur`.
      sharedCell.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })

    expect(save).not.toHaveBeenCalled()
    expect(clearLocal).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('confirms before checking Sync, naming the discarded value and the empty destination', async () => {
    const { container, root } = await mount()
    const sync = inputs(row(container, 'baseUrl')).find((i) => i.type === 'checkbox')!

    await act(async () => {
      sync.click()
      await Promise.resolve()
    })

    // Nothing is written until the user confirms.
    expect(save).not.toHaveBeenCalled()
    expect(clearLocal).not.toHaveBeenCalled()

    const body = document.body.textContent ?? ''
    expect(body).toContain('environment.local.recheck.title')
    expect(body).toContain('http://localhost:9200') // the value being discarded
    expect(body).toContain('environment.local.recheck.emptyDestination')

    await act(async () => root.unmount())
  })

  it('materializes then clears the local entry when the Sync confirmation is accepted', async () => {
    const { container, root } = await mount()
    const sync = inputs(row(container, 'baseUrl')).find((i) => i.type === 'checkbox')!

    await act(async () => {
      sync.click()
      await Promise.resolve()
    })
    const confirm = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'environment.local.recheck.confirm'
    )!
    await act(async () => {
      confirm.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(save).toHaveBeenCalledOnce()
    const saved = save.mock.calls[0][0] as Environment
    expect(saved.variables.baseUrl).toBe('')
    expect(clearLocal).toHaveBeenCalledWith('dev', 'baseUrl')
    // The local value never travels into the shared file (REQ-0108 §6.1).
    expect(Object.values(saved.variables)).not.toContain('http://localhost:9200')

    await act(async () => root.unmount())
  })

  it('cancelling the Sync confirmation writes nothing', async () => {
    const { container, root } = await mount()
    const sync = inputs(row(container, 'baseUrl')).find((i) => i.type === 'checkbox')!

    await act(async () => {
      sync.click()
      await Promise.resolve()
    })
    const cancel = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'common.cancel'
    )!
    await act(async () => {
      cancel.click()
      await Promise.resolve()
    })

    expect(save).not.toHaveBeenCalled()
    expect(clearLocal).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('deleting a shared variable removes its local entry too', async () => {
    const { root } = await mount()
    // A shared plain row renders its name in an editable input; its delete button is
    // the first `keyValue.remove` in the list (the unshared row's comes after it).
    const remove = [...document.body.querySelectorAll('button')].filter(
      (b) => b.getAttribute('aria-label') === 'keyValue.remove'
    )[0]

    await act(async () => {
      remove.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(clearLocal).toHaveBeenCalledWith('dev', 'apiKey')

    await act(async () => root.unmount())
  })
})

/**
 * REQ-0111 — the two auto-save flows are the only ones in this editor with no
 * Save button, so a swallowed rejection was invisible: the row kept showing the
 * new value as if it were persisted, and the edit was gone on reload. Every
 * sibling flow in this file already toasts its failures; these two did not.
 */
describe('auto-save failure is surfaced', () => {
  it('CA-14: toasts the reason and keeps the typed value when the write is rejected', async () => {
    save.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    const pushed: { message: string; type?: string }[] = []
    useToastStore.setState({
      push: (message: string, opts?: { type?: string }) => {
        pushed.push({ message, type: opts?.type })
        return 'toast-id'
      }
    } as Partial<ReturnType<typeof useToastStore.getState>> as never)

    const { container, root } = await mount()
    const sharedCell = inputs(row(container, 'baseUrl')).find(
      (i) => i.getAttribute('aria-label') === 'environment.local.sharedColumn'
    )!

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!
      setter.call(sharedCell, 'https://team.example.com')
      sharedCell.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      sharedCell.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    // The failure reached the user, carrying the underlying reason.
    expect(pushed).toHaveLength(1)
    expect(pushed[0].message).toContain('EACCES: permission denied')
    expect(pushed[0].type).toBe('error')

    // …and the value the user typed is still there to retry with — reverting it
    // would destroy their input on top of the failed write.
    const after = inputs(row(container, 'baseUrl')).find(
      (i) => i.getAttribute('aria-label') === 'environment.local.sharedColumn'
    )!
    expect(after.value).toBe('https://team.example.com')

    await act(async () => root.unmount())
  })
})

/**
 * ENV-SAVE-002 — the drag-reorder commit is the second auto-save path. It shares
 * the rejection handler with the field commit, so this asserts the wiring, not
 * the rule (which ENV-SAVE-001 proves).
 */
describe('reorder auto-save failure is surfaced', () => {
  const TWO_SHARED: Environment = {
    id: 'dev',
    folder: 'dev',
    name: 'dev',
    variables: { apiKey: 'shared-key', region: 'eu-west-1' }
  }

  function twoSharedView(): EnvironmentLocalView {
    return {
      environmentId: 'dev',
      rows: (['apiKey', 'region'] as const).map((name) => ({
        name,
        sharedKind: 'plain' as const,
        hasLocalOverride: false,
        localOnly: false,
        orphan: false,
        invalid: false,
        divergent: false
      }))
    }
  }

  beforeEach(() => {
    // Two shared variables, so the editor renders the sortable list rather than
    // the static one — the sortable branch is what carries the reorder callback.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api.localValues.getView = vi.fn().mockResolvedValue(twoSharedView())
    useEnvironmentStore.setState({
      environments: [TWO_SHARED],
      activeEnvironmentId: 'dev',
      baselines: { dev: { ...TWO_SHARED.variables } }
    })
  })

  it('CA-15: toasts the reason when persisting a reordering is rejected', async () => {
    save.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
    const pushed: { message: string; type?: string }[] = []
    useToastStore.setState({
      push: (message: string, opts?: { type?: string }) => {
        pushed.push({ message, type: opts?.type })
        return 'toast-id'
      }
    } as Partial<ReturnType<typeof useToastStore.getState>> as never)

    const { container, root } = await mount()
    const reorder = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'test-reorder'
    )
    expect(reorder).toBeDefined()

    await act(async () => {
      reorder!.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(save).toHaveBeenCalledOnce()
    expect(pushed).toHaveLength(1)
    expect(pushed[0].message).toContain('ENOSPC: no space left on device')
    expect(pushed[0].type).toBe('error')

    await act(async () => root.unmount())
  })
})

// ── The panel is an editor, not a selector ──────────────────────────────────
//
// Which environment is *active* is the user's call, made through the toolbar
// dropdown. Browsing or editing another environment in the maintenance panel must
// not re-point it — silently applying a different environment to the next send is
// exactly the surprise this guards against.

describe('the panel never changes the active environment', () => {
  const OTHER: Environment = {
    id: 'prod',
    folder: 'prod',
    name: 'prod',
    variables: { apiKey: 'prod-key' }
  }

  beforeEach(() => {
    useEnvironmentStore.setState({
      environments: [ENV, OTHER],
      activeEnvironmentId: 'dev',
      baselines: { dev: { ...ENV.variables }, prod: { ...OTHER.variables } }
    })
  })

  /** The left-hand list row for `name`. */
  function envRow(name: string): HTMLElement {
    const found = [...document.body.querySelectorAll('[data-env-row]')].find((el) =>
      el.textContent?.includes(name)
    )
    if (!found) throw new Error(`no environment row for ${name}`)
    return found as HTMLElement
  }

  it('selecting another environment and closing leaves the active one alone', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api.workspaceState = { setActiveEnvironment }
    useEnvironmentStore.setState({ workspacePath: '/ws' })

    const onClose = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<EnvironmentEditorModal onClose={onClose} />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Browse the environment that is not active, then close the panel.
    await act(async () => {
      envRow('prod').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      document.body
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(useEnvironmentStore.getState().activeEnvironmentId).toBe('dev')
    expect(setActiveEnvironment).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('still re-points the active environment when the active one is deleted', async () => {
    // The exception that must survive: the active environment ceased to exist, so
    // something has to take its place — otherwise the app points at nothing.
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api.workspaceState = { setActiveEnvironment }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api.environment.delete = vi.fn().mockResolvedValue(undefined)
    // UI-01: main keeps its own send environment, re-pointed only through the
    // cookie channel. Deleting the active environment must move it too.
    const cookiesSetActive = vi.fn().mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api.cookies = {
      setActiveEnvironment: cookiesSetActive,
      list: vi.fn().mockResolvedValue([])
    }
    useEnvironmentStore.setState({ workspacePath: '/ws' })

    await act(async () => {
      await useEnvironmentStore.getState().deleteEnvironment('dev')
    })

    expect(useEnvironmentStore.getState().activeEnvironmentId).toBe('prod')
    expect(setActiveEnvironment).toHaveBeenCalledWith('prod')
    expect(cookiesSetActive).toHaveBeenCalledWith('prod')
    expect(useCookieStore.getState().environmentId).toBe('prod')
  })

  it('deleting the last environment re-points main to no environment', async () => {
    useEnvironmentStore.setState({ environments: [ENV] })
    const cookiesSetActive = vi.fn().mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).api
    api.workspaceState = { setActiveEnvironment: vi.fn().mockResolvedValue(undefined) }
    api.environment.delete = vi.fn().mockResolvedValue(undefined)
    api.cookies = { setActiveEnvironment: cookiesSetActive, list: vi.fn() }
    useEnvironmentStore.setState({ workspacePath: '/ws' })

    await act(async () => {
      await useEnvironmentStore.getState().deleteEnvironment('dev')
    })

    expect(useEnvironmentStore.getState().activeEnvironmentId).toBeNull()
    expect(cookiesSetActive).toHaveBeenCalledWith(null)
  })

  it('deleting an environment that is not active leaves main where it is', async () => {
    const cookiesSetActive = vi.fn().mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).api
    api.workspaceState = { setActiveEnvironment: vi.fn().mockResolvedValue(undefined) }
    api.environment.delete = vi.fn().mockResolvedValue(undefined)
    api.cookies = { setActiveEnvironment: cookiesSetActive, list: vi.fn() }
    useEnvironmentStore.setState({ workspacePath: '/ws' })

    await act(async () => {
      await useEnvironmentStore.getState().deleteEnvironment('prod')
    })

    expect(useEnvironmentStore.getState().activeEnvironmentId).toBe('dev')
    expect(cookiesSetActive).not.toHaveBeenCalled()
  })
})

// ── Make secret (SEC-06, SEC-09) ────────────────────────────────────────────

/** The make-secret button of the plain row whose name input holds `name`. */
function lockOf(name: string): HTMLButtonElement {
  const nameInput = inputs(document.body).find((i) => i.value === name)
  if (!nameInput) throw new Error(`no plain row for ${name}`)
  const btn = [...(nameInput.closest('.group') as HTMLElement).querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === 'secrets.makeSecret'
  )
  return btn as HTMLButtonElement
}

describe('make secret', () => {
  it('SEC-09: the lock is disabled for a reserved `$` name', async () => {
    useEnvironmentStore.setState({
      environments: [{ ...ENV, variables: { apiKey: 'shared-key', $apiKey: 'v' } }],
      baselines: { dev: { apiKey: 'shared-key', $apiKey: 'v' } }
    })
    const { root } = await mount()

    expect(lockOf('$apiKey').disabled).toBe(true)
    expect(lockOf('apiKey').disabled).toBe(false)

    await act(async () => root.unmount())
  })

  it('SEC-06: a double click on the lock runs first-time setup once', async () => {
    let finishSetup: (v: { key: string; keyId: string }) => void = () => undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secretsApi = (window as any).api.secrets
    secretsApi.setup = vi.fn(
      () =>
        new Promise((resolve) => {
          finishSetup = resolve
        })
    )
    const { root } = await mount()
    const lock = lockOf('apiKey')

    await act(async () => {
      lock.click()
      lock.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    // The second click is ignored, and the lock is disabled while setup runs.
    expect(secretsApi.setup).toHaveBeenCalledOnce()
    expect(lockOf('apiKey').disabled).toBe(true)

    await act(async () => {
      finishSetup({ key: 'FPK1-TEST', keyId: '0123456789abcdef' })
      await Promise.resolve()
    })
    expect(secretsApi.setup).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
  })
})

// ── Reveal errors (UI-08) ───────────────────────────────────────────────────
//
// Only a corrupt value offers "Clear and re-enter", which overwrites the stored
// ciphertext. A missing key must never get there: the ciphertext is valid.

describe('reveal errors', () => {
  const SECRET_ENV: Environment = {
    id: 'dev',
    folder: 'dev',
    name: 'dev',
    variables: { apiToken: 'enc:v1:abc' }
  }
  const UNLOCKED = {
    hasManifest: true,
    unlocked: true,
    backend: 'os-keychain',
    keyId: '0123456789abcdef'
  }

  beforeEach(() => {
    useEnvironmentStore.setState({
      environments: [SECRET_ENV],
      activeEnvironmentId: 'dev',
      baselines: { dev: { ...SECRET_ENV.variables } }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).api
    api.secrets.status = vi.fn().mockResolvedValue(UNLOCKED)
    api.localValues.getView = vi.fn().mockResolvedValue({ environmentId: 'dev', rows: [] })
  })

  async function clickReveal(): Promise<void> {
    const eye = [...document.body.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'secrets.reveal'
    )!
    await act(async () => {
      eye.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('a missing key refreshes the status and opens Enter key, never Corrupt', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).api
    api.secrets.reveal = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'secrets:reveal': Error: SECRETS_KEY_MISSING: " +
            'No workspace key available to decrypt secret variables. ' +
            'Enter the key in the app or set FETCHPIER_WORKSPACE_KEY.'
        )
      )
    const { root } = await mount()
    api.secrets.status.mockResolvedValue({ ...UNLOCKED, unlocked: false })
    const callsBefore = api.secrets.status.mock.calls.length

    await clickReveal()

    const body = document.body.textContent ?? ''
    expect(body).not.toContain('secrets.corrupt')
    expect(body).not.toContain('secrets.clearReenter')
    expect(api.secrets.status.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(body).toContain('secrets.enterKey.title')

    await act(async () => root.unmount())
  })

  it('a corrupt value marks the row Corrupt', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api.secrets.reveal = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'secrets:reveal': Error: SECRETS_VALUE_CORRUPT: " +
            'Secret "apiToken" in environment "dev" could not be decrypted ' +
            '(authentication failed) — possible tampering or wrong key for this value.'
        )
      )
    const { root } = await mount()

    await clickReveal()

    const body = document.body.textContent ?? ''
    expect(body).toContain('secrets.corrupt')
    expect(body).toContain('secrets.clearReenter')

    await act(async () => root.unmount())
  })

  it('any other failure is a toast, not Corrupt', async () => {
    const pushed: string[] = []
    useToastStore.setState({
      push: (message: string) => {
        pushed.push(message)
        return 'toast-id'
      }
    } as Partial<ReturnType<typeof useToastStore.getState>> as never)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api.secrets.reveal = vi
      .fn()
      .mockRejectedValue(new Error('REQUEST_CANCELLED: Reveal was not authorized.'))
    const { root } = await mount()

    await clickReveal()

    expect(document.body.textContent).not.toContain('secrets.corrupt')
    expect(pushed).toEqual(['REQUEST_CANCELLED: Reveal was not authorized.'])

    await act(async () => root.unmount())
  })

  it('the status is refreshed when the workspace changes while the editor is open', async () => {
    useEnvironmentStore.setState({ workspacePath: 'C:/ws-a' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (window as any).api.secrets.status
    const { root } = await mount()
    const callsBefore = status.mock.calls.length

    status.mockResolvedValue({ ...UNLOCKED, unlocked: false, keyId: 'fedcba9876543210' })
    await act(async () => {
      useEnvironmentStore.setState({ workspacePath: 'C:/ws-b' })
      await Promise.resolve()
    })

    expect(status.mock.calls.length).toBe(callsBefore + 1)
    expect(useSecretsStore.getState().status).toMatchObject({ unlocked: false })

    await act(async () => root.unmount())
  })
})
