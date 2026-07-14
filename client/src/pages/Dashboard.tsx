import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import TakeOverDialog from '../components/TakeOverDialog';
import Action from '../iconmode/Action';
import { formatServerTs } from '../util/serverDate';
import type { TestRun } from '../types';

export default function Dashboard() {
  const { user } = useAuth();
  const canEdit = user?.role === 'admin' || user?.role === 'editor';
  // Admin can't act on runs (see requireCanRun on server); only editors +
  // runners see Start / Resume / Take over / Finish.
  const canRun = user?.role === 'editor' || user?.role === 'runner';
  // Editors may delete only DRAFT runs; deleting an active run is admin-only
  // (mirrors the server rule in routes/testRuns.ts DELETE /:id).
  const canDeleteDraftRun = user?.role === 'admin' || user?.role === 'editor';
  const canDeleteActiveRun = user?.role === 'admin';
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [takeOverTarget, setTakeOverTarget] = useState<TestRun | null>(null);
  const navigate = useNavigate();

  const fetchRuns = async () => {
    try {
      const [active, composing] = await Promise.all([
        api.testRuns.list({ status: 'active' }),
        api.testRuns.list({ status: 'composing' }),
      ]);
      setRuns([...active, ...composing]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchRuns(); }, []);

  const handleStart = async (id: number) => {
    try {
      await api.testRuns.start(id);
      navigate(`/run/${id}`);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const openTakeOver = (run: TestRun) => setTakeOverTarget(run);
  const closeTakeOver = () => setTakeOverTarget(null);
  const onTakeOverSuccess = () => {
    const id = takeOverTarget?.id;
    setTakeOverTarget(null);
    if (id) navigate(`/run/${id}`);
  };

  const handleDelete = async (run: TestRun) => {
    const msg = run.status === 'active'
      ? `Delete the in-progress run "${run.name}"? This discards its recorded progress and cannot be undone.`
      : 'Delete this test run draft?';
    if (!confirm(msg)) return;
    try {
      await api.testRuns.delete(run.id);
      fetchRuns();
    } catch (e: any) {
      alert(e.message);
    }
  };

  // A run "belongs to" its runner_name.
  const isMine = (run: TestRun) => run.runner_name === user?.username;

  if (loading) return <div className="text-gray-400 text-sm">Loading...</div>;

  const activeRuns = runs.filter((r) => r.status === 'active');
  const composingRuns = runs.filter((r) => r.status === 'composing');

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">Dashboard</h1>

      {error && <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded p-3">{error}</div>}

      {activeRuns.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-green-700 mb-2">
            {activeRuns.length === 1 ? 'Active Test Run' : 'Active Test Runs'}
          </h2>
          <div className="space-y-2">
            {activeRuns.map((run) => (
              <div
                key={run.id}
                className="bg-white border border-green-200 rounded-lg p-4 flex items-center justify-between"
              >
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
                  {run.started_at && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      Started {formatServerTs(run.started_at)}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  {isMine(run) ? (
                    <Link
                      to={`/run/${run.id}`}
                      className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700"
                    >
                      <Action icon="resume">Resume</Action>
                    </Link>
                  ) : (
                    <>
                      <Link
                        to={`/run/${run.id}`}
                        className="px-3 py-2 border text-gray-600 text-sm font-medium rounded hover:bg-gray-50"
                      >
                        <Action icon="eye">View</Action>
                      </Link>
                      {canRun && (() => {
                        // cooldown_active is server-authoritative — the
                        // client no longer computes it from a timestamp.
                        const locked = !!run.cooldown_active;
                        return (
                          <button
                            onClick={() => openTakeOver(run)}
                            disabled={locked}
                            title={locked
                              ? 'This runner seems to be active — try again later'
                              : 'Take over this run'}
                            className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <Action icon="swap">Take over</Action>
                          </button>
                        );
                      })()}
                    </>
                  )}
                  {/* Deleting an in-progress run is admin-only — it destroys
                      live work. Editors can only delete drafts (below). */}
                  {canDeleteActiveRun && (
                    <button
                      onClick={() => handleDelete(run)}
                      title="Delete this in-progress run"
                      className="px-3 py-2 text-red-600 text-sm font-medium rounded border border-red-200 hover:bg-red-50"
                    >
                      <Action icon="trash">Delete</Action>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {composingRuns.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-blue-700 mb-2">Drafted Runs</h2>
          <div className="space-y-2">
            {composingRuns.map((run) => (
              <div
                key={run.id}
                className="bg-white border rounded-lg p-4 flex items-center justify-between"
              >
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
                </div>
                <div className="flex gap-2">
                  {canRun && isMine(run) && (
                    <button
                      onClick={() => handleStart(run.id)}
                      className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700"
                    >
                      <Action icon="play">Start</Action>
                    </button>
                  )}
                  {/* No take over on drafts — that would be a pure steal from
                      the person composing. Server rejects with 400 too. */}
                  {canDeleteDraftRun && (
                    <button
                      onClick={() => handleDelete(run)}
                      className="px-3 py-1.5 text-red-600 text-sm font-medium rounded border border-red-200 hover:bg-red-50"
                    >
                      <Action icon="trash">Delete</Action>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeRuns.length === 0 && composingRuns.length === 0 && (
        <div className="bg-white border rounded-lg p-8 text-center text-gray-400">
          <p className="mb-2 text-sm">No active or drafted test runs.</p>
          {canRun && (
            <Link to="/compose" className="text-blue-600 text-sm hover:underline">
              Create a new test run →
            </Link>
          )}
        </div>
      )}

      <div className={`grid gap-3 pt-2 ${canEdit && canRun ? 'grid-cols-3' : canEdit || canRun ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {canEdit && (
          <Link
            to="/edit"
            className="bg-white border rounded-lg p-4 text-center hover:shadow-sm hover:border-gray-300 transition-all"
          >
            <div className="text-gray-800 font-medium text-sm">Edit Mode</div>
            <div className="text-gray-400 text-xs mt-1">Manage test cases</div>
          </Link>
        )}
        {canRun && (
          <Link
            to="/compose"
            className="bg-white border rounded-lg p-4 text-center hover:shadow-sm hover:border-gray-300 transition-all"
          >
            <div className="text-gray-800 font-medium text-sm">New Test Run</div>
            <div className="text-gray-400 text-xs mt-1">Compose &amp; start</div>
          </Link>
        )}
        <Link
          to="/history"
          className="bg-white border rounded-lg p-4 text-center hover:shadow-sm hover:border-gray-300 transition-all"
        >
          <div className="text-gray-800 font-medium text-sm">History</div>
          <div className="text-gray-400 text-xs mt-1">Completed runs</div>
        </Link>
      </div>

      {takeOverTarget && (
        <TakeOverDialog
          runId={takeOverTarget.id}
          runName={takeOverTarget.name}
          currentRunner={takeOverTarget.runner_name}
          onClose={closeTakeOver}
          onSuccess={onTakeOverSuccess}
        />
      )}
    </div>
  );
}
