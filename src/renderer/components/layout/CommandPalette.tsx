import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, FilePlus, Palette, Settings, Trash2, Search, Layers } from 'lucide-react'
import { cn } from '../../lib/utils'
import { fuzzyMatch } from '../../lib/fuzzy'
import { useWorkspaceStore } from '../../stores/workspace'
import { useRequestStore } from '../../stores/request'
import { useEnvironmentStore } from '../../stores/environment'
import { useThemeStore } from '../../stores/theme'
import { OPEN_SETTINGS_EVENT, HISTORY_UPDATED_EVENT } from '../../lib/events'
import type { WorkspaceTree } from '../../../shared/types'

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
}

type CommandKind = 'file' | 'action' | 'environment'

interface Command {
  id: string
  kind: CommandKind
  group: string
  label: string
  icon: React.ReactNode
  hint?: string
  run: () => void
}

function flattenTree(nodes: WorkspaceTree[], prefix = ''): { path: string; label: string }[] {
  const result: { path: string; label: string }[] = []
  for (const node of nodes) {
    if (node.type === 'file') {
      const name = node.name.replace(/\.http$/, '')
      result.push({ path: node.path, label: prefix ? `${prefix} / ${name}` : name })
    } else if (node.type === 'folder' && node.children) {
      result.push(...flattenTree(node.children, prefix ? `${prefix} / ${node.name}` : node.name))
    }
  }
  return result
}

function PaletteContent({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const openTab = useRequestStore((s) => s.openTab)
  const setActiveTab = useRequestStore((s) => s.setActiveTab)
  const promoteTab = useRequestStore((s) => s.promoteTab)
  const environments = useEnvironmentStore((s) => s.environments)
  const activeEnvironmentId = useEnvironmentStore((s) => s.activeEnvironmentId)
  const setActiveEnvironment = useEnvironmentStore((s) => s.setActive)
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme)
  const setTheme = useThemeStore((s) => s.setTheme)

  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<{ path: string; label: string }[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
    if (!workspacePath) return
    let cancelled = false
    window.api.filesystem
      .readTree()
      .then((tree) => {
        if (!cancelled) setFiles(flattenTree(tree))
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openFile = useCallback(
    (filePath: string, label: string) => {
      // REQ-0085: reaching a request by name is intentional navigation, so the
      // palette always lands on a permanent tab — if it is currently the preview,
      // promote it rather than leave it ephemeral.
      const existing = useRequestStore.getState().tabs.find((tab) => tab.filePath === filePath)
      if (existing) {
        promoteTab(existing.id)
        setActiveTab(existing.id)
      } else {
        openTab({ title: label.split(' / ').pop() ?? label, filePath })
      }
      onClose()
    },
    [openTab, promoteTab, setActiveTab, onClose]
  )

  const commands = useMemo<Command[]>(() => {
    const actions: Command[] = [
      {
        id: 'action:new-request',
        kind: 'action',
        group: t('commandPalette.groups.actions'),
        label: t('commandPalette.actions.newRequest'),
        icon: <FilePlus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
        run: () => {
          openTab()
          onClose()
        }
      },
      {
        id: 'action:toggle-theme',
        kind: 'action',
        group: t('commandPalette.groups.actions'),
        label: t('commandPalette.actions.toggleTheme'),
        icon: <Palette className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
        hint: resolvedTheme === 'dark' ? 'light' : 'dark',
        run: () => {
          setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
          onClose()
        }
      },
      {
        id: 'action:open-settings',
        kind: 'action',
        group: t('commandPalette.groups.actions'),
        label: t('commandPalette.actions.openSettings'),
        icon: <Settings className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
        run: () => {
          window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT))
          onClose()
        }
      }
    ]

    if (workspacePath) {
      actions.push({
        id: 'action:clear-history',
        kind: 'action',
        group: t('commandPalette.groups.actions'),
        label: t('commandPalette.actions.clearHistory'),
        icon: <Trash2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
        run: async () => {
          try {
            await window.api.history.clear()
            window.dispatchEvent(new CustomEvent(HISTORY_UPDATED_EVENT))
          } catch (err) {
            console.error(err)
          }
          onClose()
        }
      })
    }

    const envCommands: Command[] = environments.map((env) => ({
      id: `env:${env.id}`,
      kind: 'environment',
      group: t('commandPalette.groups.environments'),
      label: env.name,
      icon: <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
      hint: activeEnvironmentId === env.id ? '●' : undefined,
      run: () => {
        setActiveEnvironment(env.id)
        onClose()
      }
    }))

    const fileCommands: Command[] = files.map((f) => ({
      id: `file:${f.path}`,
      kind: 'file',
      group: t('commandPalette.groups.files'),
      label: f.label,
      icon: <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
      run: () => openFile(f.path, f.label)
    }))

    return [...actions, ...envCommands, ...fileCommands]
  }, [
    t,
    files,
    environments,
    activeEnvironmentId,
    resolvedTheme,
    workspacePath,
    openTab,
    setTheme,
    setActiveEnvironment,
    openFile,
    onClose
  ])

  const filtered = useMemo(
    () => (query ? commands.filter((c) => fuzzyMatch(c.label, query)) : commands),
    [commands, query]
  )

  const safeIndex = Math.min(selectedIndex, Math.max(filtered.length - 1, 0))

  // Group filtered list by group, preserving order
  const groups = useMemo(() => {
    const map = new Map<string, { items: Command[]; startIndex: number }>()
    filtered.forEach((cmd, idx) => {
      const g = map.get(cmd.group)
      if (g) {
        g.items.push(cmd)
      } else {
        map.set(cmd.group, { items: [cmd], startIndex: idx })
      }
    })
    return Array.from(map.entries()).map(([name, data]) => ({
      name,
      items: data.items,
      startIndex: data.startIndex
    }))
  }, [filtered])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = filtered[safeIndex]
        if (item) item.run()
      }
    },
    [filtered, safeIndex, onClose]
  )

  return (
    <div className="w-full max-w-lg rounded-lg border border-border bg-background shadow-2xl overflow-hidden">
      {/* Search input */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder={t('commandPalette.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelectedIndex(0)
          }}
          onKeyDown={handleKeyDown}
        />
      </div>

      {/* Results */}
      <div className="max-h-80 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {workspacePath ? t('commandPalette.empty') : t('commandPalette.noWorkspace')}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.name}>
              <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {group.name}
              </p>
              {group.items.map((cmd, localIdx) => {
                const globalIdx = group.startIndex + localIdx
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                      globalIdx === safeIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-accent'
                    )}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                    onClick={() => cmd.run()}
                  >
                    {cmd.icon}
                    <span className="flex-1 truncate">{cmd.label}</span>
                    {cmd.hint && (
                      <span className="text-[11px] text-muted-foreground">{cmd.hint}</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps): React.JSX.Element | null {
  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 dark:bg-white/10 pt-[20vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <PaletteContent onClose={onClose} />
    </div>
  )
}
