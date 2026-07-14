import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, logCsvUrl } from '../api';
import Action from '../iconmode/Action';
import { formatServerTs } from '../util/serverDate';
import { useAuth } from '../auth/AuthContext';
import { useLibrary } from '../library/LibraryContext';
import type { LogEvent } from '../types';

// Admin-only browser for the event log. Records key actions — sign-ins,
// content edits, run compose/start/finish, take over, and password
// changes/resets — not every keystroke. Server returns the latest 200
// events; anything older lives only in the CSV export (link at the top).
export default function Log() {
  const { user, isLoading } = useAuth();
  const { setActiveLibrary } = useLibrary();
  const navigate = useNavigate();
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Clicking a library name in Details switches the active library and
  // opens Edit Mode. Libraries don't have a dedicated detail page, so
  // Edit Mode is the natural destination.
  const openLibrary = (id: number) => {
    setActiveLibrary(id);
    navigate('/edit');
  };

  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    api.log.list()
      .then((r) => { setEvents(r.events); setTotal(r.total); })
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  }, [user]);

  if (isLoading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') {
    return (
      <div className="max-w-md mx-auto mt-8 bg-white border rounded-lg p-6 text-center">
        <h1 className="text-xl font-bold text-gray-800 mb-2">Log is admin-only</h1>
        <p className="text-sm text-gray-500">Your account doesn't have access to this page.</p>
      </div>
    );
  }

  const truncated = total > events.length;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-800">Log</h1>
        <a
          href={logCsvUrl}
          className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
          title="Download the full history as CSV"
        >
          <Action icon="download">Download CSV</Action>
        </a>
      </div>

      {truncated && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-900 mb-4">
          Showing the latest {events.length} of {total} entries. For older rows, use Download CSV.
        </div>
      )}

      {loading ? (
        <div className="text-gray-400 text-sm">Loading…</div>
      ) : error ? (
        <div className="text-red-600 text-sm">{error}</div>
      ) : events.length === 0 ? (
        <div className="bg-white border rounded-lg p-10 text-center text-gray-400 text-sm">
          No entries.
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Event</th>
                <th className="text-left px-3 py-2">Actor</th>
                <th className="text-left px-3 py-2">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {events.map((e) => {
                // Details cell absorbs optional context (library, run,
                // previous runner, reason). Rows for events without any
                // of them (login, password_change) get a single '—'.
                const hasLibrary = e.library_id != null || e.library_name != null;
                const hasRun = e.test_run_id != null || e.test_run_name != null;
                const hasPrev = !!e.previous_runner;
                const hasReason = !!e.reason;
                const empty = !hasLibrary && !hasRun && !hasPrev && !hasReason;
                return (
                  <tr key={e.id} className="align-top">
                    <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                      {formatServerTs(e.created_at)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700">{e.event_type}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-800">{e.actor_username}</td>
                    <td className="px-3 py-2 text-gray-700 space-y-0.5">
                      {empty && <span className="text-gray-300">—</span>}
                      {hasLibrary && (
                        <div>
                          <span className="text-gray-500">Library </span>
                          {e.library_id ? (
                            <button
                              type="button"
                              onClick={() => openLibrary(e.library_id!)}
                              className="text-blue-600 hover:underline"
                              title="Open this library in Edit Mode"
                            >
                              {e.library_name || `#${e.library_id}`}
                            </button>
                          ) : (
                            <span className="text-gray-500 italic">{e.library_name || '(deleted)'}</span>
                          )}
                        </div>
                      )}
                      {hasRun && (
                        <div>
                          <span className="text-gray-500">Run </span>
                          {e.test_run_id ? (
                            <Link
                              to={`/history/${e.test_run_id}`}
                              className="text-blue-600 hover:underline"
                              title="Open this run's history"
                            >
                              {e.test_run_name || `#${e.test_run_id}`}
                            </Link>
                          ) : (
                            <span className="text-gray-500 italic">{e.test_run_name || '(deleted)'}</span>
                          )}
                        </div>
                      )}
                      {hasPrev && (
                        <div>
                          <span className="text-gray-500">Previous </span>
                          <span>{e.previous_runner}</span>
                        </div>
                      )}
                      {hasReason && (
                        <div className="whitespace-pre-wrap break-words">{e.reason}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
