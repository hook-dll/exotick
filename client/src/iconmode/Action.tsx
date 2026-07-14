import type { ReactNode } from 'react';
import { useIconMode } from './IconMode';
import Glyph from './Glyph';

// Wraps a button's (or link's) label. In normal mode it renders the label
// verbatim; when the icon-mode egg is active it renders the matching line
// icon instead — but always with the original word as an accessible name and
// hover tooltip, so nothing is ever cryptic.
//
//   <button ...><Action icon="play">Start</Action></button>
//
// For dynamic/pending labels pass an explicit `label` for the tooltip:
//   <Action icon="x" label="Revoke">{pending ? 'Revoking…' : 'Revoke'}</Action>
export default function Action({
  icon,
  label,
  children,
}: {
  icon: string;
  label?: string;
  children: ReactNode;
}) {
  const { enabled } = useIconMode();
  if (!enabled) return <>{children}</>;
  const word = label ?? (typeof children === 'string' ? children : icon);
  // The word rides on the span as an HTML `title` (reliable tooltip position)
  // plus aria-label (accessible name); the glyph itself is decorative.
  return (
    <span className="action-glyph-wrap" title={word} role="img" aria-label={word}>
      <Glyph name={icon} className="action-glyph" />
    </span>
  );
}
