import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button, buttonVariants } from './button'

const classes = (value: string): string[] => value.split(' ')

function renderedClasses(element: React.ReactElement): string[] {
  const match = /class="([^"]*)"/.exec(renderToStaticMarkup(element))
  return classes(match?.[1] ?? '')
}

describe('buttonVariants', () => {
  it('applies the base classes plus the default variant and size', () => {
    const result = classes(buttonVariants())
    expect(result).toContain('inline-flex')
    expect(result).toContain('bg-primary')
    expect(result).toContain('h-9')
    expect(result).toContain('px-4')
  })

  it.each([
    ['default', 'bg-primary'],
    ['destructive', 'bg-destructive'],
    ['outline', 'border-input'],
    ['secondary', 'bg-secondary'],
    ['ghost', 'hover:bg-accent'],
    ['link', 'underline-offset-4']
  ] as const)('variant %s applies its classes', (variant, expected) => {
    expect(classes(buttonVariants({ variant }))).toContain(expected)
  })

  it.each([
    ['default', 'h-9'],
    ['sm', 'h-8'],
    ['lg', 'h-10'],
    ['icon', 'w-9']
  ] as const)('size %s applies its classes', (size, expected) => {
    expect(classes(buttonVariants({ size }))).toContain(expected)
  })

  it('applies only the chosen variant', () => {
    expect(classes(buttonVariants({ variant: 'ghost' }))).not.toContain('bg-primary')
  })

  it('treats undefined as the default', () => {
    expect(buttonVariants({ variant: undefined, size: undefined })).toBe(buttonVariants())
  })

  it('emits no classes for a dimension set to null', () => {
    const result = classes(buttonVariants({ variant: null, size: null }))
    expect(result).toContain('inline-flex')
    expect(result).not.toContain('bg-primary')
    expect(result).not.toContain('h-9')
  })

  it('appends className last, without resolving conflicts itself', () => {
    const result = buttonVariants({ size: 'sm', className: 'h-12 extra' })
    expect(result.endsWith('h-12 extra')).toBe(true)
    expect(classes(result)).toContain('h-8')
  })
})

describe('Button', () => {
  it('renders a button with the variant classes', () => {
    const result = renderedClasses(<Button variant="outline">Go</Button>)
    expect(result).toContain('border-input')
    expect(renderToStaticMarkup(<Button>Go</Button>)).toMatch(/^<button /)
  })

  it('lets className win a Tailwind conflict with the variant classes', () => {
    const result = renderedClasses(
      <Button size="sm" className="h-12 extra">
        Go
      </Button>
    )
    expect(result).toContain('h-12')
    expect(result).toContain('extra')
    expect(result).not.toContain('h-8')
  })

  it('renders its child element instead of a button with asChild', () => {
    const markup = renderToStaticMarkup(
      <Button asChild variant="link">
        <a href="#x">Go</a>
      </Button>
    )
    expect(markup).toMatch(/^<a /)
    expect(markup).toContain('underline-offset-4')
  })
})
