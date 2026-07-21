// Fold toggle shown at the left of every container header (module / sub-module
// / section) in Edit Mode and Compose. Stops click propagation so it never
// fights the checkbox or row selection beside it.
export default function Chevron({ open, onToggle, title }: { open: boolean; onToggle: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={title ?? (open ? 'Collapse' : 'Expand')}
      className="shrink-0 w-4 text-gray-400 hover:text-gray-600 text-xs leading-none select-none"
    >
      {open ? '▾' : '▸'}
    </button>
  );
}
