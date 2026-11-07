/**
 * The selection/hover look of a collection-tree row.
 *
 * Selection (the active request, the selected folder) uses the selection tint;
 * an unselected row gets the neutral hover colour, and only on hover. A selected
 * row never takes the hover colour, so the two states are always told apart —
 * which they were not when the selected folder used the hover colour itself.
 */
export function treeRowStateClass({
  selected,
  emphasis
}: {
  selected: boolean
  /** The active request also reads in medium weight. */
  emphasis: boolean
}): string {
  if (!selected) return 'hover:bg-accent hover:text-accent-foreground'
  return emphasis
    ? 'bg-primary-tint font-medium text-foreground'
    : 'bg-primary-tint text-foreground'
}
