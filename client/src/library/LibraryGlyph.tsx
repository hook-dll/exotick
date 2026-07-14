// A classical-building glyph (the "landmark" icon) that marks the library
// selector — the top level of the case → section → library hierarchy. Inline
// SVG rather than an emoji so it renders identically on every OS and tints via
// `currentColor` to match the theme accent. Shared by the Compose/Edit picker
// and the History filter so every library select is marked the same way.
export default function LibraryGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="12 2 20 7 4 7" />
      <line x1="6" x2="6" y1="18" y2="11" />
      <line x1="10" x2="10" y1="18" y2="11" />
      <line x1="14" x2="14" y1="18" y2="11" />
      <line x1="18" x2="18" y1="18" y2="11" />
      <line x1="3" x2="21" y1="22" y2="22" />
    </svg>
  );
}
