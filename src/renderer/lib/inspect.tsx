import React from 'react'
import type { ScriptArgSentinel } from '../../shared/types'

const MAX_DEPTH = 3

function isSentinel(v: unknown): v is ScriptArgSentinel {
  return typeof v === 'object' && v !== null && '__inspect' in v
}

function inspectValue(value: unknown, depth: number, seen: WeakSet<object>): React.ReactNode {
  if (value === null) {
    return <span className="italic text-muted-foreground">null</span>
  }
  if (value === undefined) {
    return <span className="italic text-muted-foreground">undefined</span>
  }

  const type = typeof value

  if (type === 'string') {
    return <span className="text-console-string">&quot;{value as string}&quot;</span>
  }

  if (type === 'number' || type === 'bigint') {
    return <span className="text-console-number">{String(value)}</span>
  }

  if (type === 'boolean') {
    return <span className="text-console-boolean">{String(value)}</span>
  }

  if (type === 'function') {
    const fn = value as { name?: string }
    return <span className="text-console-function">[Function: {fn.name || '(anonymous)'}]</span>
  }

  if (type === 'object' && isSentinel(value)) {
    if (value.__inspect === 'fn') {
      return <span className="text-console-function">[Function: {value.name}]</span>
    }
    if (value.__inspect === 'circular') {
      return <span className="italic text-muted-foreground">[Circular]</span>
    }
    if (value.__inspect === 'truncated') {
      return (
        <span className="text-muted-foreground">{value.kind === 'array' ? '[...]' : '{…}'}</span>
      )
    }
  }

  if (type === 'object') {
    const obj = value as object

    if (seen.has(obj)) {
      return <span className="italic text-muted-foreground">[Circular]</span>
    }

    seen.add(obj)

    if (Array.isArray(obj)) {
      if (depth >= MAX_DEPTH) {
        seen.delete(obj)
        return <span className="text-muted-foreground">[...]</span>
      }
      const items = obj.map((item, i) => (
        <React.Fragment key={i}>
          {inspectValue(item, depth + 1, seen)}
          {i < obj.length - 1 && <span className="text-muted-foreground">, </span>}
        </React.Fragment>
      ))
      seen.delete(obj)
      return (
        <span>
          <span className="text-muted-foreground">[</span>
          {items}
          <span className="text-muted-foreground">]</span>
        </span>
      )
    }

    if (depth >= MAX_DEPTH) {
      seen.delete(obj)
      return (
        <span className="text-muted-foreground">
          {'{'}&hellip;{'}'}
        </span>
      )
    }

    const entries = Object.entries(obj)
    const rendered = entries.map(([key, val], i) => (
      <React.Fragment key={key}>
        <span className="text-foreground">{key}</span>
        <span className="text-muted-foreground">: </span>
        {inspectValue(val, depth + 1, seen)}
        {i < entries.length - 1 && <span className="text-muted-foreground">, </span>}
      </React.Fragment>
    ))

    seen.delete(obj)
    return (
      <span>
        <span className="text-muted-foreground">{'{ '}</span>
        {rendered}
        <span className="text-muted-foreground">{' }'}</span>
      </span>
    )
  }

  return <span>{String(value)}</span>
}

export function inspect(value: unknown, depth = 0): React.ReactNode {
  return inspectValue(value, depth, new WeakSet())
}

export function inspectLine(args: unknown[]): React.ReactNode {
  return (
    <>
      {args.map((arg, i) => (
        <React.Fragment key={i}>
          {inspect(arg)}
          {i < args.length - 1 && ' '}
        </React.Fragment>
      ))}
    </>
  )
}
