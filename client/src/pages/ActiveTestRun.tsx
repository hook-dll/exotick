import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import confetti from 'canvas-confetti';
import { api } from '../api';
import MarkdownView from '../components/MarkdownView';
import TakeOverDialog from '../components/TakeOverDialog';
import Action from '../iconmode/Action';
import { useAuth } from '../auth/AuthContext';
import type { SectionColor, TestRunItem, TestRunWithItems } from '../types';

// Two-side cannon burst that lasts ~1.5s. The canvas that canvas-confetti
// attaches lives on document.body, so it survives the client-side
// navigate to /history/:id — the user sees the confetti trailing off as
// the history page loads.
function celebrateFinish() {
  const durationMs = 1500;
  const end = Date.now() + durationMs;
  const colors = ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#a855f7'];
  const tick = () => {
    confetti({ particleCount: 3, angle: 60,  spread: 55, origin: { x: 0 }, colors });
    confetti({ particleCount: 3, angle: 120, spread: 55, origin: { x: 1 }, colors });
    if (Date.now() < end) requestAnimationFrame(tick);
  };
  tick();
}

export default function ActiveTestRun() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [run, setRun] = useState<TestRunWithItems | null>(null);
  const [loading, setLoading] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [takeOverOpen, setTakeOverOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<TestRunItem | null>(null);
  // Only editors + runners can mark, and only when they own the run.
  // Admin has no runner role (see requireCanRun on server); watchers can
  // never mark. Take over in the banner reassigns runner_name so canMark
  // flips back to true.
  const canRun = user?.role === 'editor' || user?.role === 'runner';
  const isOwner = run?.runner_name === user?.username;
  const canMark = canRun && isOwner;
  // section name → color, looked up from the live sections list so the tint a
  // user picks in Edit Mode is reflected here (matched by name; if a section
  // is renamed the group falls back to no tint until re-picked).
  const [colorByName, setColorByName] = useState<Map<string, SectionColor | null>>(new Map());

  const fetchRun = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.testRuns.get(Number(id));
      setRun(data);
    } catch {
      // On any non-401 failure (404/500/network) fall through to the "not
      // found" state rather than hanging on "Loading..." forever. A 401 is
      // handled globally (onUnauthorized → /login), so setRun(null) is a
      // harmless no-op in that case.
      setRun(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchRun(); }, [fetchRun]);

  // Redirect completed runs to their history view. Done in an effect, not in
  // the render body, so we never call navigate() while rendering.
  useEffect(() => {
    if (run?.status === 'completed' && id) navigate(`/history/${id}`, { replace: true });
  }, [run?.status, id, navigate]);

  // Fetch live section colors for THIS run's library so the section
  // headers here match the tints picked in Edit Mode. Runs on runs from
  // other libraries stay tint-less (section-name matches nothing) — that's
  // fine, snapshot text still renders. Watchers can't read library content
  // (server 403s), so skip it — untinted headers are purely cosmetic.
  useEffect(() => {
    if (!run) return;
    if (user?.role === 'watcher') return;
    api.sections.list(run.library_id).then(({ sections }) => {
      setColorByName(new Map(sections.map((s) => [s.name, s.color])));
    }).catch(() => { /* fall back to no colors */ });
  }, [run?.library_id, user?.role]);

  const handleItemClick = async (item: TestRunItem, clicked: 'pass' | 'fail') => {
    const newStatus = item.status === clicked ? null : clicked;
    setRun((prev) =>
      prev
        ? { ...prev, items: prev.items.map((i) => (i.id === item.id ? { ...i, status: newStatus } : i)) }
        : null
    );
    if (selectedItem?.id === item.id) {
      setSelectedItem((prev) => prev ? { ...prev, status: newStatus } : null);
    }
    try {
      await api.testRuns.updateItem(item.id, newStatus);
    } catch {
      fetchRun();
    }
  };

  const handleFinish = async () => {
    if (!run || !id) return;
    const unmarked = run.items.filter((i) => i.status === null).length;
    const msg =
      unmarked > 0
        ? `Finish run? ${unmarked} unmarked test case${unmarked !== 1 ? 's' : ''} will be marked as SKIP.`
        : 'Mark this test run as complete?';
    if (!confirm(msg)) return;
    setFinishing(true);
    try {
      await api.testRuns.finish(Number(id));
      celebrateFinish();
      navigate(`/history/${id}`);
    } catch (e: any) {
      alert(e.message);
      setFinishing(false);
    }
  };

  const onTakeOverSuccess = async () => {
    setTakeOverOpen(false);
    await fetchRun();
  };

  if (loading) return <div className="text-gray-400 text-sm">Loading...</div>;
  if (!run) return <div className="text-red-600">Test run not found.</div>;

  // The redirect itself is fired by the effect above; just render nothing
  // while it happens.
  if (run.status === 'completed') return null;

  if (run.status === 'composing') {
    return (
      <div className="text-gray-500 text-sm">
        This run is drafted but not yet started. Start it from the{' '}
        <a href="/" className="text-blue-500 hover:underline">Dashboard</a>.
      </div>
    );
  }

  const total = run.items.length;
  const passed = run.items.filter((i) => i.status === 'pass').length;
  const failed = run.items.filter((i) => i.status === 'fail').length;
  const marked = passed + failed;

  const groups = new Map<string, TestRunItem[]>();
  for (const item of run.items) {
    const key = item.snapshot_section_name ?? 'Unsectioned';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  // Banner only for editor+/runner non-owners. Watchers/admin see a silent
  // read-only run.
  const showTakeOverBanner = !isOwner && canRun;
  const canTakeOver = showTakeOverBanner;

  // cooldown_active is server-authoritative. The client used to compute
  // this from item timestamps, which leaked when the current runner last
  // acted; the server now returns just the boolean.
  const takeOverLocked = !!run.cooldown_active;

  return (
    <>
      {showTakeOverBanner && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-center justify-between gap-4">
          <div className="text-sm text-amber-900">
            <span className="font-semibold">Assigned to {run.runner_name ?? '(no one)'}.</span>{' '}
            You can view the run below but cannot mark items until you take it over.
          </div>
          {canTakeOver && (
            <button
              onClick={() => setTakeOverOpen(true)}
              disabled={takeOverLocked}
              title={takeOverLocked
                ? 'This runner seems to be active — try again later'
                : 'Take over this run'}
              className="shrink-0 px-3 py-1.5 text-sm bg-amber-600 text-white font-medium rounded hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Action icon="swap">Take over</Action>
            </button>
          )}
        </div>
      )}
      {takeOverOpen && (
        <TakeOverDialog
          runId={run.id}
          runName={run.name}
          currentRunner={run.runner_name}
          onClose={() => setTakeOverOpen(false)}
          onSuccess={onTakeOverSuccess}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">
            {run.name}
            <span className="ml-2 text-base text-gray-400 font-normal">#{run.id}</span>
          </h1>
          {run.library_name && (
            <p className="text-xs text-gray-400 mt-0.5">Library: {run.library_name}</p>
          )}
          {run.runner_name && (
            <p className="text-sm text-gray-500 mt-0.5">Runner: {run.runner_name}</p>
          )}
        </div>
        {canMark && (
          <button
            onClick={handleFinish}
            disabled={finishing}
            className="px-4 py-2 bg-gray-800 text-white text-sm font-medium rounded hover:bg-gray-900 disabled:opacity-50 shrink-0 ml-4"
          >
            <Action icon="flag" label="Finish Run">{finishing ? 'Finishing...' : 'Finish Run'}</Action>
          </button>
        )}
      </div>

    <div className="flex gap-5">
      {/* Left — test case list */}
      <div className="w-3/5 min-w-0 flex flex-col gap-4">

        {/* Progress */}
        <div className="bg-white border rounded-lg p-4">
          <div className="flex justify-between text-xs text-gray-500 mb-1.5">
            <span>{marked} / {total} marked</span>
            <span className="text-green-600 font-medium">{passed} pass</span>
            <span className="text-red-500 font-medium">{failed} fail</span>
            <span>{total - marked} remaining</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden flex">
            <div
              className="bg-green-500 transition-all duration-200"
              style={{ width: total > 0 ? `${(passed / total) * 100}%` : '0%' }}
            />
            <div
              className="bg-red-400 transition-all duration-200"
              style={{ width: total > 0 ? `${(failed / total) * 100}%` : '0%' }}
            />
          </div>
        </div>

        {/* Test cases */}
        <div className="space-y-3">
          {[...groups.entries()].map(([sectionName, items]) => {
            const color = colorByName.get(sectionName) ?? null;
            const tintClass = color ? ` section-tint-${color}` : '';
            return (
            <div key={sectionName} className="bg-white border rounded-lg overflow-hidden">
              <div className={`px-4 py-2 border-b text-sm font-semibold text-gray-700${tintClass}`}>
                {sectionName}
              </div>
              <div className="divide-y">
                {items.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => setSelectedItem(item)}
                    className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${
                      selectedItem?.id === item.id ? 'ring-2 ring-inset ring-blue-400' : ''
                    } ${
                      item.status === 'pass'
                        ? 'bg-green-50'
                        : item.status === 'fail'
                        ? 'bg-red-50'
                        : ''
                    }`}
                  >
                    <span className="flex-1 text-sm text-gray-700 select-none">{item.snapshot_description}</span>
                    {canMark ? (
                      <div className="flex gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handleItemClick(item, 'pass')}
                          className={`px-3 py-1 rounded text-sm font-medium border transition-colors ${
                            item.status === 'pass'
                              ? 'bg-green-600 text-white border-green-600'
                              : 'border-green-500 text-green-600 hover:bg-green-50'
                          }`}
                        >
                          <Action icon="check">Pass</Action>
                        </button>
                        <button
                          onClick={() => handleItemClick(item, 'fail')}
                          className={`px-3 py-1 rounded text-sm font-medium border transition-colors ${
                            item.status === 'fail'
                              ? 'bg-red-600 text-white border-red-600'
                              : 'border-red-400 text-red-500 hover:bg-red-50'
                          }`}
                        >
                          <Action icon="x">Fail</Action>
                        </button>
                      </div>
                    ) : (
                      // Non-owner / watcher view: static status pill instead of Pass/Fail buttons.
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                        item.status === 'pass' ? 'bg-green-100 text-green-700'
                        : item.status === 'fail' ? 'bg-red-100 text-red-700'
                        : 'bg-gray-100 text-gray-400'
                      }`}>
                        {item.status ? item.status.toUpperCase() : '—'}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            );
          })}
        </div>

        {canMark && (
          <button
            onClick={handleFinish}
            disabled={finishing}
            className="w-full py-2.5 bg-gray-800 text-white text-sm font-medium rounded hover:bg-gray-900 disabled:opacity-50"
          >
            <Action icon="flag" label="Finish Run">{finishing ? 'Finishing...' : 'Finish Run'}</Action>
          </button>
        )}
      </div>

      {/* Right — description panel */}
      <div className="w-2/5 min-w-0 sticky top-0 self-start">
        <div className="bg-white border rounded-lg overflow-hidden min-h-[200px]">
          {selectedItem ? (
            <div>
              <div className="px-4 py-3 border-b bg-gray-50">
                <p className="text-sm font-medium text-gray-800">{selectedItem.snapshot_description}</p>
                <p className="text-xs text-gray-400 mt-0.5">{selectedItem.snapshot_section_name ?? 'Unsectioned'}</p>
              </div>
              <div className="px-4 py-4">
                {selectedItem.snapshot_notes ? (
                  <MarkdownView content={selectedItem.snapshot_notes} />
                ) : (
                  <p className="text-sm text-gray-400 italic">No description for this test case.</p>
                )}
              </div>
            </div>
          ) : (
            <div className="px-4 py-6 text-sm text-gray-400 text-center">
              Click a test case to view its description
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
