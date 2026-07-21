import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import MarkdownView from '../components/MarkdownView';
import Chevron from '../components/Chevron';
import LibraryPicker from '../library/LibraryPicker';
import Action from '../iconmode/Action';
import { useAuth } from '../auth/AuthContext';
import { useLibrary } from '../library/LibraryContext';
import type { Module, Section, SubModule, TestCase } from '../types';

function TriCheckbox({
  checked, indeterminate, onChange, title, className,
}: {
  checked: boolean; indeterminate?: boolean; onChange: () => void; title?: string; className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      title={title}
      className={`cursor-pointer accent-blue-600 ${className ?? ''}`}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export default function ComposeTestRun() {
  const { user } = useAuth();
  const { activeLibrary, activeLibraryId, setActiveLibrary, isLoading: librariesLoading } = useLibrary();
  const canEditCases = user?.role === 'admin' || user?.role === 'editor';
  const canCompose = user?.role === 'editor' || user?.role === 'runner';
  const [modules, setModules] = useState<Module[]>([]);
  const [rootSubModules, setRootSubModules] = useState<SubModule[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [unsectioned, setUnsectioned] = useState<TestCase[]>([]);
  const [name, setName] = useState('');
  const [runnerName, setRunnerName] = useState(user?.username ?? '');
  const [roster, setRoster] = useState<string[]>([]);
  const [selectedCases, setSelectedCases] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Fold state — session-only. Keys: `m:<id>` / `sm:<id>` / `s:<id>`.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  // Refetch sections whenever the active library changes. Also clears the
  // per-library selection state — cross-library composition isn't allowed.
  useEffect(() => {
    if (activeLibraryId == null) { setLoading(false); return; }
    setLoading(true);
    setSelectedCases(new Set());
    setSelectedId(null);
    api.sections.list(activeLibraryId).then(({ modules: m, sub_modules: rs, sections: s, unsectioned: u }) => {
      setModules(m);
      setRootSubModules(rs);
      setSections(s);
      setUnsectioned(u);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [activeLibraryId]);

  // Roster (usernames, no admin) — same across libraries.
  useEffect(() => {
    api.users.roster()
      .then(({ usernames }) => setRoster(usernames))
      .catch(() => setRoster([]));
  }, []);

  // Confirm before switching libraries mid-compose if the user already
  // picked cases — the server won't accept a cross-library selection anyway.
  const handleLibraryChange = (nextId: number) => {
    if (selectedCases.size > 0) {
      if (!confirm(`Switch library? Your current selection (${selectedCases.size} case${selectedCases.size === 1 ? '' : 's'}) will be cleared.`)) {
        // Restore old value in the picker by re-setting the active library
        // to what it was. React will re-render the <select>.
        setActiveLibrary(activeLibraryId!);
        return;
      }
    }
    setActiveLibrary(nextId);
  };

  const toggleCase = (id: number) =>
    setSelectedCases((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const toggleAllIn = (cases: TestCase[]) =>
    setSelectedCases((prev) => {
      const n = new Set(prev);
      const all = cases.length > 0 && cases.every((c) => n.has(c.id));
      cases.forEach((c) => (all ? n.delete(c.id) : n.add(c.id)));
      return n;
    });

  const handleSubmit = async (startNow: boolean) => {
    if (!name.trim()) { alert('Run name is required.'); return; }
    if (!runnerName.trim()) { alert('Runner name is required.'); return; }
    if (selectedCases.size === 0) { alert('Select at least one test case.'); return; }

    setSubmitting(true);
    try {
      const run = await api.testRuns.create({
        name: name.trim(),
        runner_name: runnerName.trim() || undefined,
        case_ids: [...selectedCases],
      });
      if (startNow) {
        await api.testRuns.start(run.id);
        navigate(`/run/${run.id}`);
      } else {
        navigate('/');
      }
    } catch (e: any) {
      alert(e.message);
      setSubmitting(false);
    }
  };

  if (librariesLoading) return <div className="text-gray-400 text-sm">Loading libraries…</div>;
  if (loading) return <div className="text-gray-400 text-sm">Loading library…</div>;
  if (!canCompose) {
    // Message is role-aware — a watcher lands here differently from an
    // admin (both are blocked at the API layer, but the reason is not the
    // same, so the copy shouldn't be either).
    const explanation = user?.role === 'watcher'
      ? 'Your role is watcher — read-only access. Ask an editor or runner to compose a run, then watch it live from the Dashboard.'
      : user?.role === 'admin'
      ? 'Admin accounts manage the app but don\'t run tests. Sign in as an editor or runner to compose or work a run.'
      : 'You don\'t have permission to compose test runs.';
    return (
      <div className="max-w-md mx-auto mt-8 bg-white border rounded-lg p-6 text-center">
        <h1 className="text-xl font-bold text-gray-800 mb-2">Test runs aren't for this account</h1>
        <p className="text-sm text-gray-500">{explanation}</p>
      </div>
    );
  }

  // Flattened views across every container + root, for totals + preview lookup.
  const allSections = [
    ...modules.flatMap((m) => [...m.sub_modules.flatMap((sm) => sm.sections), ...m.sections]),
    ...rootSubModules.flatMap((sm) => sm.sections),
    ...sections,
  ];
  const allUnsectioned = [
    ...modules.flatMap((m) => [...m.sub_modules.flatMap((sm) => sm.unsectioned), ...m.unsectioned]),
    ...rootSubModules.flatMap((sm) => sm.unsectioned),
    ...unsectioned,
  ];

  const totalSelected = selectedCases.size;
  const totalAvailable =
    allSections.reduce((sum, s) => sum + s.test_cases.length, 0) + allUnsectioned.length;

  // Every module / sub-module / section key — used by Collapse all.
  const allCollapsibleKeys = (): string[] => {
    const keys: string[] = [];
    for (const m of modules) {
      keys.push(`m:${m.id}`);
      for (const sm of m.sub_modules) { keys.push(`sm:${sm.id}`); for (const s of sm.sections) keys.push(`s:${s.id}`); }
      for (const s of m.sections) keys.push(`s:${s.id}`);
    }
    for (const sm of rootSubModules) { keys.push(`sm:${sm.id}`); for (const s of sm.sections) keys.push(`s:${s.id}`); }
    for (const s of sections) keys.push(`s:${s.id}`);
    return keys;
  };
  const collapseAll = () => setCollapsed(new Set(allCollapsibleKeys()));
  const expandAll = () => setCollapsed(new Set());
  const isEmpty = modules.length === 0 && rootSubModules.length === 0 && sections.length === 0 && unsectioned.length === 0;

  const selected = (() => {
    if (selectedId == null) return null;
    for (const s of allSections) {
      const tc = s.test_cases.find((c) => c.id === selectedId);
      if (tc) return { tc, sectionName: s.name };
    }
    const u = allUnsectioned.find((c) => c.id === selectedId);
    return u ? { tc: u, sectionName: 'Unsectioned' } : null;
  })();

  const renderCaseRow = (tc: TestCase) => (
    <div
      key={tc.id}
      className={`py-1.5 border-b border-gray-100 last:border-0 flex items-start gap-2 ${
        selectedId === tc.id ? 'bg-blue-50' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={selectedCases.has(tc.id)}
        onChange={() => toggleCase(tc.id)}
        className="mt-1 cursor-pointer accent-blue-600 shrink-0"
        title="Include this case"
      />
      <button
        type="button"
        onClick={() => setSelectedId(tc.id)}
        title="Click to view its description on the right"
        className={`flex-1 min-w-0 text-left text-sm flex items-start gap-1.5 ${
          selectedId === tc.id ? 'text-blue-600 font-medium' : 'text-gray-700'
        }`}
      >
        <span>{tc.description}</span>
        {tc.notes && (
          <span className="shrink-0 text-gray-300 mt-0.5" title="Has a description">📄</span>
        )}
      </button>
    </div>
  );

  const renderSectionCard = (section: Section) => {
    const caseIds = section.test_cases.map((c) => c.id);
    const allSelected = caseIds.length > 0 && caseIds.every((id) => selectedCases.has(id));
    const someSelected = caseIds.some((id) => selectedCases.has(id));
    const inSection = caseIds.filter((id) => selectedCases.has(id)).length;
    const tintClass = section.color ? ` section-tint-${section.color}` : '';
    const secKey = `s:${section.id}`;
    const secOpen = !collapsed.has(secKey);
    return (
      <div key={section.id} className="bg-white border rounded-lg overflow-hidden">
        <div className={`flex items-center gap-2 px-3 py-2${secOpen && section.test_cases.length > 0 ? ' border-b' : ''}${tintClass}`}>
          <Chevron open={secOpen} onToggle={() => toggleCollapse(secKey)} title={secOpen ? 'Collapse section' : 'Expand section'} />
          <TriCheckbox
            checked={allSelected}
            indeterminate={someSelected}
            onChange={() => toggleAllIn(section.test_cases)}
            title="Select all cases in section"
            className="shrink-0"
          />
          <span className="flex-1 font-semibold text-gray-800">{section.name}</span>
          <span className="text-xs text-gray-400">{inSection}/{caseIds.length}</span>
        </div>
        {secOpen && section.test_cases.length > 0 && (
          <div className="px-3 py-2">{section.test_cases.map(renderCaseRow)}</div>
        )}
      </div>
    );
  };

  const renderSubModuleCard = (sm: SubModule) => {
    const headerTint = sm.color ? `section-tint-${sm.color}` : 'submodule-header-plain';
    const subKey = `sm:${sm.id}`;
    const subOpen = !collapsed.has(subKey);
    return (
      <div key={`sub-${sm.id}`} className="submodule-shell overflow-hidden">
        <div className={`submodule-header flex items-center gap-2 px-3 py-2 text-sm font-semibold ${headerTint}`}>
          <Chevron open={subOpen} onToggle={() => toggleCollapse(subKey)} title={subOpen ? 'Collapse sub-module' : 'Expand sub-module'} />
          <span>{sm.name}</span>
        </div>
        {subOpen && (
          <div className="p-3 space-y-3">
            {sm.sections.map(renderSectionCard)}
            {renderUnsecCard(sm.unsectioned, `su-${sm.id}`)}
          </div>
        )}
      </div>
    );
  };

  const renderUnsecCard = (cases: TestCase[], key: string) => {
    if (cases.length === 0) return null;
    const uIds = cases.map((c) => c.id);
    const uAll = uIds.length > 0 && uIds.every((id) => selectedCases.has(id));
    const uSome = uIds.some((id) => selectedCases.has(id));
    const uInSel = uIds.filter((id) => selectedCases.has(id)).length;
    return (
      <div key={key} className="bg-white border rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b">
          <TriCheckbox
            checked={uAll}
            indeterminate={uSome}
            onChange={() => toggleAllIn(cases)}
            title="Select all unsectioned cases"
            className="shrink-0"
          />
          <span className="flex-1 font-semibold text-gray-400">Unsectioned</span>
          <span className="text-xs text-gray-300">{uInSel}/{uIds.length}</span>
        </div>
        <div className="px-3 py-2">{cases.map(renderCaseRow)}</div>
      </div>
    );
  };

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap mb-3 text-sm">
        <span className="text-xs uppercase tracking-wide text-gray-400">Library</span>
        <LibraryPicker onChange={handleLibraryChange} />
        {activeLibrary && (
          <span className="text-xs text-gray-400">— pick cases from this library only</span>
        )}
      </div>

      <h1 className="text-2xl font-bold text-gray-800 mb-4">Compose Test Run</h1>

    <div className="flex gap-6">
      <div className="w-3/5 min-w-0">

        <div className="sticky top-0 z-30 -mx-1 mb-4 bg-white border rounded-lg shadow-sm p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Run Name <span className="text-red-500">*</span>
              </label>
              <input
                className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                placeholder="e.g. Sprint 14 Regression"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Runner <span className="text-red-500">*</span>
              </label>
              <select
                className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                value={runnerName}
                onChange={(e) => setRunnerName(e.target.value)}
              >
                {(roster.length > 0 ? roster : [user?.username ?? '']).map((u) => (
                  <option key={u} value={u}>{u}{u === user?.username ? ' (you)' : ''}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-3 pt-3 border-t flex items-center gap-3">
            <span className="text-sm text-gray-600 flex-1">
              <span className="font-semibold text-gray-800">{totalSelected}</span>
              <span className="text-gray-400"> / {totalAvailable}</span> test case
              {totalSelected === 1 ? '' : 's'} selected
              {activeLibrary && <span className="text-gray-400"> in "{activeLibrary.name}"</span>}
            </span>
            <button
              onClick={() => handleSubmit(false)}
              disabled={submitting || totalSelected === 0}
              className="py-1.5 px-4 border border-blue-600 text-blue-600 text-sm font-medium rounded hover:bg-blue-50 disabled:opacity-50"
            >
              <Action icon="draft">Save as Draft</Action>
            </button>
            <button
              onClick={() => handleSubmit(true)}
              disabled={submitting || totalSelected === 0}
              className="py-1.5 px-4 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50"
            >
              <Action icon="rocket" label="Save & Start">Save &amp; Start</Action>
            </button>
          </div>
        </div>

        {isEmpty ? (
          <div className="bg-white border rounded-lg p-6 text-center text-gray-400 text-sm">
            {canEditCases ? (
              <>
                No test cases in this library yet. Add some in{' '}
                <a href="/edit" className="text-blue-500 hover:underline">Edit Mode</a> first.
              </>
            ) : (
              <>No test cases in this library yet — ask an editor to add some.</>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex justify-end">
              <div className="flex items-center rounded border border-gray-200 overflow-hidden">
                <button onClick={expandAll} className="px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100" title="Expand all containers">
                  <Action icon="chevronDown" label="Expand all">▾ Expand all</Action>
                </button>
                <button onClick={collapseAll} className="px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 border-l border-gray-200" title="Collapse all containers">
                  <Action icon="chevronRight" label="Collapse all">▸ Collapse all</Action>
                </button>
              </div>
            </div>
            {modules.map((m) => {
              const headerTint = m.color ? `section-tint-${m.color}` : 'module-header-plain';
              const modKey = `m:${m.id}`;
              const modOpen = !collapsed.has(modKey);
              return (
                <div key={m.id} className="module-shell overflow-hidden">
                  <div className={`module-header flex items-center gap-2 px-3 py-2 text-sm font-bold tracking-wide ${headerTint}`}>
                    <Chevron open={modOpen} onToggle={() => toggleCollapse(modKey)} title={modOpen ? 'Collapse module' : 'Expand module'} />
                    <span>{m.name}</span>
                  </div>
                  {modOpen && (
                    <div className="p-3 space-y-3">
                      {m.sub_modules.map(renderSubModuleCard)}
                      {m.sections.map(renderSectionCard)}
                      {renderUnsecCard(m.unsectioned, `mu-${m.id}`)}
                    </div>
                  )}
                </div>
              );
            })}
            {rootSubModules.map(renderSubModuleCard)}
            {sections.map(renderSectionCard)}
            {renderUnsecCard(unsectioned, 'root-unsec')}
          </div>
        )}

      </div>

      <div className="w-2/5 min-w-0 sticky top-0 self-start">
        <div className="bg-white border rounded-lg overflow-hidden min-h-[200px]">
          {selected ? (
            <div>
              <div className="px-4 py-3 border-b bg-gray-50">
                <p className="text-sm font-medium text-gray-800">{selected.tc.description}</p>
                <p className="text-xs text-gray-400 mt-0.5">{selected.sectionName}</p>
              </div>
              <div className="px-4 py-4">
                {selected.tc.notes ? (
                  <MarkdownView content={selected.tc.notes} />
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
