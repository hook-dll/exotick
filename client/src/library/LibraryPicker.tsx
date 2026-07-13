import { useLibrary } from './LibraryContext';

// Small dropdown that switches the active library. Used by both Edit Mode
// (top toolbar) and Compose (top toolbar). Rename / delete / create are
// Edit-Mode-only affordances and live in EditMode.tsx.
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
    <select
      disabled={disabled}
      value={activeLibraryId ?? ''}
      onChange={(e) => {
        const next = Number(e.target.value);
        setActiveLibrary(next);
        onChange?.(next);
      }}
      className="border rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 max-w-[14rem] truncate"
      title="Switch library"
    >
      {libraries.map((l) => (
        <option key={l.id} value={l.id}>{l.name}</option>
      ))}
    </select>
  );
}
