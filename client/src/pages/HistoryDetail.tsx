import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import MarkdownView from '../components/MarkdownView';
import { useAuth } from '../auth/AuthContext';
import type { SectionColor, TestRunItem, TestRunWithItems } from '../types';

function StatusBadge({ status }: { status: TestRunItem['status'] }) {
  switch (status) {
    case 'pass':
      return <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded-full font-medium">PASS</span>;
    case 'fail':
      return <span className="text-xs px-2 py-0.5 bg-red-100 text-red-700 rounded-full font-medium">FAIL</span>;
    case 'skip':
      return <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full font-medium">SKIP</span>;
    default:
      return <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-300 rounded-full">—</span>;
  }
}

export default function HistoryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  // Completed runs are admin-only to delete (server enforces the same via
  // requireRole('editor') + a status check). Editors still delete drafts
  // from the Dashboard; that's a different concern.
  const canDeleteRun = user?.role === 'admin';
  const [run, setRun] = useState<TestRunWithItems | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<TestRunItem | null>(null);
  const [colorByName, setColorByName] = useState<Map<string, SectionColor | null>>(new Map());

  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    if (!id) return;
    api.testRuns.get(Number(id)).then((data) => {
      setRun(data);
      setLoading(false);
    });
  }, [id]);

  // Fetch live section colors for THIS run's library so the section
  // headers here match the tints picked in Edit Mode.
  useEffect(() => {
    if (!run) return;
    api.sections.list(run.library_id).then(({ sections }) => {
      setColorByName(new Map(sections.map((s) => [s.name, s.color])));
    }).catch(() => { /* fall back to no colors */ });
  }, [run?.library_id]);

  const closeDelete = () => { setShowDelete(false); setDeleteError(''); };

  const confirmDelete = async () => {
    if (!run) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await api.testRuns.delete(run.id);
      navigate('/history');
    } catch (err: any) {
      setDeleteError(err.message || 'Delete failed');
      setDeleting(false);
    }
  };

  if (loading) return <div className="text-gray-400 text-sm">Loading...</div>;
  if (!run) return <div className="text-red-600">Run not found.</div>;

  const total = run.items.length;
  const passed = run.items.filter((i) => i.status === 'pass').length;
  const failed = run.items.filter((i) => i.status === 'fail').length;
  const skipped = run.items.filter((i) => i.status === 'skip').length;

  // Aggregate per-user contribution counts. Sorted by count desc so the
  // biggest contributor comes first.
  const contributors: Array<[string, number]> = (() => {
    const counts = new Map<string, number>();
    for (const it of run.items) {
      if (it.updated_by) counts.set(it.updated_by, (counts.get(it.updated_by) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  })();

  const groups = new Map<string, TestRunItem[]>();
  for (const item of run.items) {
    const key = item.snapshot_section_name ?? 'Unsectioned';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  return (
    <>
      {showDelete && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => !deleting && closeDelete()}>
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-2xl mb-1">⚠️</div>
            <h2 className="text-lg font-bold text-gray-800 mb-1">Delete this run?</h2>
            <p className="text-sm text-gray-500 mb-4">This run and its results will be permanently removed.</p>
            {deleteError && <div className="text-red-600 text-sm mt-2">{deleteError}</div>}
            <div className="flex gap-2 mt-4">
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="flex-1 px-3 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete Run'}
              </button>
              <button
                onClick={closeDelete}
                disabled={deleting}
                className="px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-4">
        <Link to="/history" className="hover:text-gray-600">History</Link>
        <span>/</span>
        <span className="text-gray-600">{run.name}</span>
      </div>

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
          {contributors.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              <span className="text-xs text-gray-400">Contributors:</span>
              {contributors.map(([username, count]) => (
                <span
                  key={username}
                  className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 rounded-full"
                  title={`${count} item${count === 1 ? '' : 's'} marked by ${username}`}
                >
                  {username} · {count}
                </span>
              ))}
            </div>
          )}
          {run.started_at && (
            <p className="text-xs text-gray-400 mt-0.5">
              Started: {new Date(run.started_at).toLocaleString()}
            </p>
          )}
          {run.finished_at && (
            <p className="text-xs text-gray-400">
              Finished: {new Date(run.finished_at).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-4">
          <a
            href={`/api/export/test-runs/${run.id}`}
            target="_blank"
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
          >
            Export PDF
          </a>
          {canDeleteRun && (
            <button
              onClick={() => setShowDelete(true)}
              className="px-3 py-1.5 text-sm bg-red-50 hover:bg-red-100 border border-red-200 rounded text-red-600"
              title="Delete this test run"
            >
              Delete Run
            </button>
          )}
        </div>
      </div>

    <div className="flex gap-5">
      {/* Left — run info + item list */}
      <div className="w-3/5 min-w-0 flex flex-col gap-4">

        {/* Summary cards */}
        <div className="grid grid-cols-4 gap-3">
          <div className="bg-white border rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-gray-800">{total}</div>
            <div className="text-xs text-gray-400 mt-0.5">Total</div>
          </div>
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-green-700">{passed}</div>
            <div className="text-xs text-green-500 mt-0.5">Pass</div>
          </div>
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-red-600">{failed}</div>
            <div className="text-xs text-red-400 mt-0.5">Fail</div>
          </div>
          <div className="bg-gray-50 border rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-gray-400">{skipped}</div>
            <div className="text-xs text-gray-400 mt-0.5">Skip</div>
          </div>
        </div>

        {/* Results by section */}
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
                    className={`flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors ${
                      selectedItem?.id === item.id ? 'ring-2 ring-inset ring-blue-400' : ''
                    }`}
                  >
                    <span className="flex-1 text-sm text-gray-700 select-none">{item.snapshot_description}</span>
                    <StatusBadge status={item.status} />
                  </div>
                ))}
              </div>
            </div>
            );
          })}
        </div>
      </div>

      {/* Right — description panel */}
      <div className="w-2/5 min-w-0 sticky top-0 self-start">
        <div className="bg-white border rounded-lg overflow-hidden min-h-[200px]">
          {selectedItem ? (
            <div>
              <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-800">{selectedItem.snapshot_description}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{selectedItem.snapshot_section_name ?? 'Unsectioned'}</p>
                </div>
                <StatusBadge status={selectedItem.status} />
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
