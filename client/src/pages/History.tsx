import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useLibrary } from '../library/LibraryContext';
import LibraryGlyph from '../library/LibraryGlyph';
import { formatServerTs } from '../util/serverDate';
import type { TestRun } from '../types';

export default function History() {
  const { user } = useAuth();
  const { libraries } = useLibrary();
  // Only editors + runners can compose. Watchers and admin see the empty-
  // state message without the "start your first run" nudge — that link
  // would lead to a page they're not allowed to use.
  const canCompose = user?.role === 'editor' || user?.role === 'runner';
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [loading, setLoading] = useState(true);
  // '' = All libraries; otherwise the numeric id as a string (matches <select> conventions).
  const [libraryFilter, setLibraryFilter] = useState<string>('');

  useEffect(() => {
    setLoading(true);
    const libId = libraryFilter ? Number(libraryFilter) : undefined;
    api.testRuns.list({ status: 'completed', library_id: libId }).then((data) => {
      setRuns(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [libraryFilter]);

  const libraryOptions = useMemo(() =>
    libraries.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>),
    [libraries]
  );

  if (loading) return <div className="text-gray-400 text-sm">Loading...</div>;

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Test Run History</h1>
        {libraries.length > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-xs text-gray-400">Library</span>
            <span className="lib-select-wrap">
              <LibraryGlyph className="lib-select-icon" />
              <select
                value={libraryFilter}
                onChange={(e) => setLibraryFilter(e.target.value)}
                className="lib-select border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                <option value="">All libraries</option>
                {libraryOptions}
              </select>
            </span>
          </div>
        )}
      </div>

      {runs.length === 0 ? (
        <div className="bg-white border rounded-lg p-10 text-center text-gray-400">
          <p className="text-sm">No completed test runs yet.</p>
          {canCompose && (
            <Link to="/compose" className="text-blue-500 text-sm hover:underline mt-2 inline-block">
              Start your first test run →
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <Link
              key={run.id}
              to={`/history/${run.id}`}
              className="block bg-white border rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition-all group"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-gray-800">
                    {run.name}
                    <span className="ml-1.5 text-xs text-gray-400 font-normal">#{run.id}</span>
                  </div>
                  {run.library_name && (
                    <div className="text-xs text-gray-400 mt-0.5">Library: {run.library_name}</div>
                  )}
                  {run.runner_name && (
                    <div className="text-xs text-gray-500 mt-0.5">Runner: {run.runner_name}</div>
                  )}
                  {run.finished_at && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      {formatServerTs(run.finished_at)}
                    </div>
                  )}
                </div>
                <span className="text-gray-400 group-hover:text-blue-500 text-2xl leading-none group-hover:translate-x-1 transition-transform">→</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
