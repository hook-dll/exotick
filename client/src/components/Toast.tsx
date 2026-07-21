import { useEffect, useRef, useState } from 'react';
import Action from '../iconmode/Action';

// A single floating notification, pinned to the bottom-right of the viewport
// (position: fixed, so it never shifts page layout and stays visible at any
// scroll). Auto-dismisses after `duration`, but the countdown pauses while the
// pointer is over it so an Undo stays reachable. `✕` dismisses immediately.
// Only one is ever rendered — a new action replaces the previous toast rather
// than stacking. Remount it with a changing React key to restart the timer.
export default function Toast({
  text,
  tone,
  onUndo,
  onDismiss,
  undoing,
  duration = 8000,
}: {
  text: string;
  tone: 'success' | 'error';
  onUndo?: () => void;
  onDismiss: () => void;
  undoing?: boolean;
  duration?: number;
}) {
  const [paused, setPaused] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => dismissRef.current(), duration);
    return () => clearTimeout(t);
  }, [paused, duration]);

  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={`fixed bottom-4 right-4 z-50 max-w-sm flex items-start gap-3 rounded-lg border px-4 py-3 shadow-lg ${
        tone === 'error'
          ? 'bg-red-50 border-red-200 text-red-700'
          : 'bg-green-50 border-green-200 text-green-700'
      }`}
    >
      <span className="text-sm flex-1 break-words">{text}</span>
      {onUndo && (
        <button
          onClick={onUndo}
          disabled={undoing}
          className="shrink-0 text-sm font-medium underline hover:no-underline disabled:opacity-50"
        >
          <Action icon="swap" label="Undo">{undoing ? 'Undoing…' : 'Undo'}</Action>
        </button>
      )}
      <button
        onClick={onDismiss}
        className="shrink-0 opacity-60 hover:opacity-100 leading-none"
        title="Dismiss"
        aria-label="Dismiss"
      >
        <Action icon="x">✕</Action>
      </button>
    </div>
  );
}
