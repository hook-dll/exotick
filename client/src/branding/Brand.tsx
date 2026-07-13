import { useBranding } from './BrandingContext';

// The logo tile is w-8 h-8 (32px). Custom logos scale to that box with
// object-cover; the default falls back to the gradient checkmark tile so
// there's always something in that slot.
export default function Brand({ variant = 'dark' }: { variant?: 'dark' | 'light' }) {
  const { name, logoUrl } = useBranding();
  // Wrap long custom names onto multiple lines instead of truncating with an
  // ellipsis (mirrors how long usernames wrap in the sidebar UserBadge).
  // break-words keeps normal spaced names on word boundaries but still breaks
  // an over-long unbroken name so it can't overflow the sidebar.
  const nameClass =
    variant === 'dark'
      ? 'min-w-0 text-white font-bold text-base tracking-tight break-words leading-tight'
      : 'min-w-0 font-bold text-lg tracking-tight text-gray-800 break-words leading-tight';

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="w-8 h-8 rounded-lg object-cover shadow-md shadow-indigo-900/40 shrink-0 bg-white"
        />
      ) : (
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white text-lg font-bold shadow-md shadow-indigo-900/40 shrink-0">
          ✓
        </div>
      )}
      <div className={nameClass}>{name}</div>
    </div>
  );
}
