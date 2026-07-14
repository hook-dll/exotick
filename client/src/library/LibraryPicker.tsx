import { useLibrary } from './LibraryContext';
import LibraryGlyph from './LibraryGlyph';

// Small dropdown that switches the active library. Used by both Edit Mode
// (top toolbar) and Compose (top toolbar). Rename / delete / create are
// Edit-Mode-only affordances and live in EditMode.tsx. The leading building
// glyph marks it as the library ("building") level of the hierarchy.
export default function LibraryPicker({
  disabled,
  onChange,
}: {
  disabled?: boolean;
  onChange?: (nextId: number) => void;
}) {
  const { libraries, activeLibraryId, setActiveLibrary } = useLibrary();
  if (libraries.length === 0) return null;
  return (
    <span className="lib-select-wrap">
      <LibraryGlyph className="lib-select-icon" />
      <select
        disabled={disabled}
        value={activeLibraryId ?? ''}
        onChange={(e) => {
          const next = Number(e.target.value);
          setActiveLibrary(next);
          onChange?.(next);
        }}
        className="lib-select border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
        title="Switch library"
      >
        {libraries.map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
    </span>
  );
}
