import { FormEvent, useState } from 'react';
import { api } from '../api';

interface Props {
  runId: number;
  runName: string;
  currentRunner: string | null;
  onClose: () => void;
  // Called after a successful takeover so the parent can refresh state
  // (Dashboard reloads the runs list, ActiveTestRun re-fetches the run).
  onSuccess: () => void;
}

const MIN_REASON_LEN = 10;

/**
 * The Take over confirmation modal. Deliberately friction-heavy: the caller
 * has to type a reason of at least 10 characters. The server enforces the
 * same rule; this UI just makes the check obvious before submitting.
 *
 * Server rejects with 409 when the cooldown since the runner's last activity
 * hasn't elapsed (the window is admin-configurable; default 60 min). The
 * buttons on the calling pages are disabled during cooldown so this
 * modal usually never sees that response, but if the state changes between
 * render and click we still surface the error inline.
 */
export default function TakeOverDialog({ runId, runName, currentRunner, onClose, onSuccess }: Props) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const trimmedLen = reason.trim().length;
  const canSubmit = trimmedLen >= MIN_REASON_LEN;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setError('');
    setBusy(true);
    try {
      await api.testRuns.takeOver(runId, reason);
      onSuccess();
    } catch (e: any) {
      setError(e.message || 'Take over failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => !busy && onClose()}>
      <form onSubmit={submit} className="bg-white rounded-lg shadow-xl p-5 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-gray-800 mb-1">Take over this run?</h2>
        <p className="text-sm text-gray-600 mb-3">
          <span className="font-medium">{runName}</span> is currently assigned to{' '}
          <span className="font-medium">{currentRunner ?? '(no one)'}</span>. After you take over, only you can mark items until it's reassigned.
        </p>

        <label className="block text-xs font-medium text-gray-700 mb-1">
          Reason <span className="text-gray-400 font-normal">(at least {MIN_REASON_LEN} characters)</span>
        </label>
        <textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => { setReason(e.target.value); setError(''); }}
          // The reason must be genuinely typed — pasting (and drag-drop, the
          // other no-type way to fill a field) is blocked so the friction is
          // real and the reason is deliberate.
          onPaste={(e) => { e.preventDefault(); setError('Please type the reason — pasting is disabled.'); }}
          onDrop={(e) => e.preventDefault()}
          onDragOver={(e) => e.preventDefault()}
          autoComplete="off"
          className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none"
          placeholder="e.g. Alice on vacation, need to continue smoke tests"
        />
        <div className="text-xs text-gray-400 mt-1 text-right">
          {trimmedLen} / {MIN_REASON_LEN}+
        </div>

        {error && <div className="text-red-600 text-sm mt-2">{error}</div>}

        <div className="flex gap-2 mt-4">
          <button
            type="submit"
            disabled={!canSubmit || busy}
            className="flex-1 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
          >
            {busy ? 'Taking over…' : 'Take over'}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
