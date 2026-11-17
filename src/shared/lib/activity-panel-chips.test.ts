import { describe, expect, it } from 'vitest'
import {
  MAX_CHIP_LABEL_LENGTH,
  MAX_MIRRORED_CHIPS,
  parseActivityPanelChips,
  parseChipRequestId
} from './activity-panel-chips'
import { MAX_ENTRY_ID_LENGTH, MAX_SOURCE_FILE_LENGTH } from './activity-panel-row-action'

const CHIP = { requestId: 'req-1', label: 'auth/bearer', checked: true }

describe('parseActivityPanelChips', () => {
  it('accepts an empty set', () => {
    expect(parseActivityPanelChips([])).toEqual([])
  })

  it('accepts chips with and without a source file, copying only their own fields', () => {
    const input = [
      { ...CHIP, extra: 'x' },
      { requestId: 'req-2', label: 'notes', checked: false, sourceFile: 'requests/notes.http' }
    ]
    const parsed = parseActivityPanelChips(input)
    expect(parsed).toEqual([
      CHIP,
      { requestId: 'req-2', label: 'notes', checked: false, sourceFile: 'requests/notes.http' }
    ])
    expect(parsed![0]).not.toBe(input[0])
    expect(parsed![0]).not.toHaveProperty('sourceFile')
  })

  it('accepts a set at the cap and refuses one over it', () => {
    const chips = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...CHIP, requestId: `req-${i}` }))
    expect(parseActivityPanelChips(chips(MAX_MIRRORED_CHIPS))).toHaveLength(MAX_MIRRORED_CHIPS)
    expect(parseActivityPanelChips(chips(MAX_MIRRORED_CHIPS + 1))).toBeNull()
  })

  it('accepts ids, labels and source files at their length limits', () => {
    const parsed = parseActivityPanelChips([
      {
        requestId: 'r'.repeat(MAX_ENTRY_ID_LENGTH),
        label: 'l'.repeat(MAX_CHIP_LABEL_LENGTH),
        checked: true,
        sourceFile: 's'.repeat(MAX_SOURCE_FILE_LENGTH)
      }
    ])
    expect(parsed).toHaveLength(1)
  })

  it.each([
    ['a non-array', { chips: [] }],
    ['null', null],
    ['a non-object entry', ['req-1']],
    ['an array entry', [[CHIP]]],
    ['a missing id', [{ label: 'a', checked: true }]],
    ['an empty id', [{ ...CHIP, requestId: '' }]],
    ['a non-string id', [{ ...CHIP, requestId: 7 }]],
    ['an id over its limit', [{ ...CHIP, requestId: 'r'.repeat(MAX_ENTRY_ID_LENGTH + 1) }]],
    ['a control character in the id', [{ ...CHIP, requestId: 'req\n1' }]],
    ['an empty label', [{ ...CHIP, label: '' }]],
    ['a non-string label', [{ ...CHIP, label: null }]],
    ['a label over its limit', [{ ...CHIP, label: 'l'.repeat(MAX_CHIP_LABEL_LENGTH + 1) }]],
    ['a control character in the label', [{ ...CHIP, label: 'a\u0000b' }]],
    ['a missing checked flag', [{ requestId: 'req-1', label: 'a' }]],
    ['a non-boolean checked flag', [{ ...CHIP, checked: 'true' }]],
    ['an absolute POSIX source file', [{ ...CHIP, sourceFile: '/etc/passwd' }]],
    ['an absolute Windows source file', [{ ...CHIP, sourceFile: 'C:/x.http' }]],
    ['a backslash-rooted source file', [{ ...CHIP, sourceFile: '\\x.http' }]],
    ['a source file with ..', [{ ...CHIP, sourceFile: 'requests/../../x.http' }]],
    ['an empty source file', [{ ...CHIP, sourceFile: '' }]],
    [
      'a source file over its limit',
      [{ ...CHIP, sourceFile: 's'.repeat(MAX_SOURCE_FILE_LENGTH + 1) }]
    ],
    ['two chips with one id', [CHIP, { ...CHIP, label: 'other' }]]
  ])('refuses %s', (_label, value) => {
    expect(parseActivityPanelChips(value)).toBeNull()
  })
})

describe('parseChipRequestId', () => {
  it('accepts an id up to its limit', () => {
    expect(parseChipRequestId('req-1')).toBe('req-1')
    expect(parseChipRequestId('r'.repeat(MAX_ENTRY_ID_LENGTH))).toHaveLength(MAX_ENTRY_ID_LENGTH)
  })

  it.each([
    ['a non-string', 1],
    ['an empty string', ''],
    ['an id over its limit', 'r'.repeat(MAX_ENTRY_ID_LENGTH + 1)],
    ['a control character', 'a\tb']
  ])('refuses %s', (_label, value) => {
    expect(parseChipRequestId(value)).toBeNull()
  })
})
