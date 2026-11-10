import { twMerge } from 'tailwind-merge'

export type ClassDictionary = Record<string, unknown>
export type ClassValue =
  ClassValue[] | ClassDictionary | string | number | bigint | boolean | null | undefined

function collect(value: ClassValue, out: string[]): void {
  if (!value || value === true) return
  if (typeof value === 'string') {
    out.push(value)
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    out.push(String(value))
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, out)
  } else {
    for (const [name, enabled] of Object.entries(value)) if (enabled) out.push(name)
  }
}

/**
 * Join class names: strings and non-zero numbers as-is, arrays flattened,
 * object keys whose value is truthy; every falsy value (and `true`) skipped.
 */
export function classNames(...inputs: ClassValue[]): string {
  const out: string[] = []
  collect(inputs, out)
  return out.join(' ')
}

export function cn(...inputs: ClassValue[]): string {
  return twMerge(classNames(inputs))
}
