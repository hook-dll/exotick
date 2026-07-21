import type { ReactNode } from 'react';
import Action from '../iconmode/Action';

// A consistent "add" affordance — a dashed ghost pill with a leading "+".
// Replaces the bare blue text links that used to be scattered across Edit Mode.
// `children` keeps its own leading "+ " so icon-mode swaps the whole label for a
// glyph (see iconmode/Action).
export default function AddButton({
  icon,
  label,
  onClick,
  children,
  title,
  className,
}: {
  icon: string;
  label?: string;
  onClick: () => void;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-dashed border-gray-300 text-xs text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-colors ${className ?? ''}`}
    >
      <Action icon={icon} label={label}>{children}</Action>
    </button>
  );
}
