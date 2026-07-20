import { useEffect, useRef, useState, KeyboardEvent } from 'react';
import { api, backupExportUrl, testCasesPdfUrl } from '../api';
import MarkdownView from '../components/MarkdownView';
import LibraryPicker from '../library/LibraryPicker';
import Action from '../iconmode/Action';
import { useAuth } from '../auth/AuthContext';
import { useLibrary } from '../library/LibraryContext';
import type { Module, Section, SectionColor, SubModule, TestCase } from '../types';

const SECTION_COLORS: readonly SectionColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

// Add-state carries the full (sectionId, moduleId, subModuleId) bucket so the
// affordances resolve to the right place — a null sectionId is ambiguous
// (root vs. a module/sub-module unsectioned pile) without the container ids.
type BulkAddState = { sectionId: number | null; moduleId: number | null; subModuleId: number | null; text: string } | null;
type EditCaseState = { id: number; desc: string; notes: string; sectionId: number | null } | null;
type EditSectionState = { id: number; name: string } | null;
// Add a section — after_id null means "append to this container".
type AddAfterState = { afterId: number | null; moduleId: number | null; subModuleId: number | null } | null;
// Add a sub-module — after_id null means "append to this module (or root)".
type AddSubAfterState = { afterId: number | null; moduleId: number | null } | null;

// Checkbox that can render the "some but not all" indeterminate state.
function TriCheckbox({
  checked, indeterminate, onChange, title, className,
}: {
  checked: boolean; indeterminate?: boolean; onChange: () => void; title?: string; className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <input ref={ref} type="checkbox" checked={checked} onChange={onChange} title={title}
      className={`cursor-pointer accent-blue-600 ${className ?? ''}`} onClick={(e) => e.stopPropagation()} />
  );
}

// Shared 6-hue color picker (+ "none") used on section, sub-module and module
// headers alike.
function ColorSwatches({ value, onPick }: { value: SectionColor | null; onPick: (c: SectionColor | null) => void }) {
  return (
    <div className="flex items-center gap-1 mr-1 pr-1 border-r border-gray-200">
      <button
        onClick={() => onPick(null)}
        title="No color"
        className={`w-3.5 h-3.5 rounded-full bg-white border border-gray-300 hover:scale-110 transition-transform transform-gpu ${value === null ? 'ring-2 ring-offset-1 ring-blue-400' : ''}`}
      />
      {SECTION_COLORS.map((c) => (
        <button
          key={c}
          onClick={() => onPick(c)}
          title={c}
          className={`w-3.5 h-3.5 rounded-full swatch-${c} border border-black/10 hover:scale-110 transition-transform transform-gpu ${value === c ? 'ring-2 ring-offset-1 ring-blue-400' : ''}`}
        />
      ))}
    </div>
  );
}

export default function EditMode() {
  const { user } = useAuth();
  const { libraries, activeLibrary, activeLibraryId, setActiveLibrary, refresh: refreshLibraries, isLoading: librariesLoading } = useLibrary();
  // Backup buttons are admin-only (see routes/backup.ts guard).
  const canBackup = user?.role === 'admin';
  const [modules, setModules] = useState<Module[]>([]);
  const [rootSubModules, setRootSubModules] = useState<SubModule[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [unsectioned, setUnsectioned] = useState<TestCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [editSection, setEditSection] = useState<EditSectionState>(null);
  const [addAfter, setAddAfter] = useState<AddAfterState>(null);
  const [newSectionName, setNewSectionName] = useState('');

  const [editCase, setEditCase] = useState<EditCaseState>(null);
  const [bulkAdd, setBulkAdd] = useState<BulkAddState>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const notesTextareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const [selCases, setSelCases] = useState<Set<number>>(new Set());
  const [selSections, setSelSections] = useState<Set<number>>(new Set());
  const [selSubModules, setSelSubModules] = useState<Set<number>>(new Set());
  const [selModules, setSelModules] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const backupInputRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  // Module-management UI state (inline). newModuleAfter null = append at end.
  const [newModuleName, setNewModuleName] = useState<string | null>(null);
  const [newModuleAfter, setNewModuleAfter] = useState<number | null>(null);
  const [renameModule, setRenameModule] = useState<{ id: number; name: string } | null>(null);

  // Sub-module-management UI state (inline).
  const [addSubAfter, setAddSubAfter] = useState<AddSubAfterState>(null);
  const [newSubModuleName, setNewSubModuleName] = useState('');
  const [renameSubModule, setRenameSubModule] = useState<{ id: number; name: string } | null>(null);

  // Library-management UI state — inline in the header, not modals.
  const [newLibName, setNewLibName] = useState<string | null>(null);
  const [renameLibName, setRenameLibName] = useState<string | null>(null);
  const [deleteLibOpen, setDeleteLibOpen] = useState(false);
  const [deleteLibTyped, setDeleteLibTyped] = useState('');
  const [deleteLibBusy, setDeleteLibBusy] = useState(false);
  const [deleteLibError, setDeleteLibError] = useState('');

  // Flattened views across every container + root — used for target pickers,
  // the preview lookup, and selection reconciliation.
  const allSections: { section: Section; moduleName: string | null; subName: string | null }[] = [
    ...modules.flatMap((m) => [
      ...m.sub_modules.flatMap((sm) => sm.sections.map((s) => ({ section: s, moduleName: m.name, subName: sm.name }))),
      ...m.sections.map((s) => ({ section: s, moduleName: m.name, subName: null })),
    ]),
    ...rootSubModules.flatMap((sm) => sm.sections.map((s) => ({ section: s, moduleName: null, subName: sm.name }))),
    ...sections.map((s) => ({ section: s, moduleName: null, subName: null })),
  ];
  const allUnsectioned: TestCase[] = [
    ...modules.flatMap((m) => [...m.sub_modules.flatMap((sm) => sm.unsectioned), ...m.unsectioned]),
    ...rootSubModules.flatMap((sm) => sm.unsectioned),
    ...unsectioned,
  ];

  const fetchData = async (libId: number) => {
    try {
      const { modules: m, sub_modules: rs, sections: s, unsectioned: u } = await api.sections.list(libId);
      setModules(m);
      setRootSubModules(rs);
      setSections(s);
      setUnsectioned(u);
      // Drop any selected ids that no longer exist.
      const allSubs = [...m.flatMap((x) => x.sub_modules), ...rs];
      const flatSecs = [
        ...m.flatMap((x) => [...x.sub_modules.flatMap((sm) => sm.sections), ...x.sections]),
        ...rs.flatMap((sm) => sm.sections),
        ...s,
      ];
      const caseIds = new Set<number>([
        ...flatSecs.flatMap((x) => x.test_cases.map((c) => c.id)),
        ...allSubs.flatMap((sm) => sm.unsectioned.map((c) => c.id)),
        ...m.flatMap((x) => x.unsectioned.map((c) => c.id)),
        ...u.map((c) => c.id),
      ]);
      const secIds = new Set<number>(flatSecs.map((x) => x.id));
      const subIds = new Set<number>(allSubs.map((x) => x.id));
      const modIds = new Set<number>(m.map((x) => x.id));
      setSelCases((prev) => new Set([...prev].filter((id) => caseIds.has(id))));
      setSelSections((prev) => new Set([...prev].filter((id) => secIds.has(id))));
      setSelSubModules((prev) => new Set([...prev].filter((id) => subIds.has(id))));
      setSelModules((prev) => new Set([...prev].filter((id) => modIds.has(id))));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeLibraryId == null) { setLoading(false); return; }
    setLoading(true);
    setEditCase(null); setBulkAdd(null);
    setEditSection(null); setAddAfter(null); setNewSectionName('');
    setNewModuleName(null); setNewModuleAfter(null); setRenameModule(null);
    setAddSubAfter(null); setNewSubModuleName(''); setRenameSubModule(null);
    setSelCases(new Set()); setSelSections(new Set()); setSelSubModules(new Set()); setSelModules(new Set()); setSelectedId(null);
    setError(''); setMessage('');
    fetchData(activeLibraryId);
  }, [activeLibraryId]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(''), 4000);
    return () => clearTimeout(t);
  }, [message]);

  const flash = (msg: string) => { setError(''); setMessage(msg); };

  // ── Library management ───────────────────────────────────────
  const createLibrary = async () => {
    const name = (newLibName ?? '').trim();
    if (!name) return;
    try {
      const lib = await api.libraries.create(name);
      setNewLibName(null);
      await refreshLibraries();
      setActiveLibrary(lib.id);
      flash(`Created library "${lib.name}".`);
    } catch (e: any) { setError(e.message); }
  };

  const saveLibraryName = async () => {
    if (!activeLibrary) return;
    const name = (renameLibName ?? '').trim();
    if (!name || name === activeLibrary.name) { setRenameLibName(null); return; }
    try {
      await api.libraries.rename(activeLibrary.id, name);
      setRenameLibName(null);
      await refreshLibraries();
      flash(`Renamed to "${name}".`);
    } catch (e: any) { setError(e.message); }
  };

  const openDeleteLibrary = () => { setDeleteLibOpen(true); setDeleteLibTyped(''); setDeleteLibError(''); };
  const closeDeleteLibrary = () => {
    if (deleteLibBusy) return;
    setDeleteLibOpen(false); setDeleteLibTyped(''); setDeleteLibError('');
  };
  const confirmDeleteLibrary = async () => {
    if (!activeLibrary) return;
    if (deleteLibTyped !== 'REALLY') return;
    setDeleteLibBusy(true); setDeleteLibError('');
    try {
      await api.libraries.delete(activeLibrary.id);
      await refreshLibraries();
      setDeleteLibOpen(false); setDeleteLibTyped('');
      flash('Library deleted.');
    } catch (e: any) {
      setDeleteLibError(e.message);
    } finally {
      setDeleteLibBusy(false);
    }
  };

  // ── Module actions ───────────────────────────────────────────
  const createModule = async () => {
    const name = (newModuleName ?? '').trim();
    if (!name || activeLibraryId == null) return;
    try {
      await api.modules.create(name, activeLibraryId, newModuleAfter != null ? { after_id: newModuleAfter } : {});
      setNewModuleName(null); setNewModuleAfter(null);
      fetchData(activeLibraryId);
      flash(`Created module "${name}".`);
    } catch (e: any) { setError(e.message); }
  };

  const saveModuleName = async () => {
    if (!renameModule || activeLibraryId == null) return;
    const name = renameModule.name.trim();
    if (!name) return;
    try {
      await api.modules.update(renameModule.id, { name });
      setRenameModule(null);
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  const setModuleColor = async (id: number, color: SectionColor | null) => {
    setModules((prev) => prev.map((m) => (m.id === id ? { ...m, color } : m)));
    try { await api.modules.update(id, { color }); }
    catch (e: any) { setError(e.message); if (activeLibraryId != null) fetchData(activeLibraryId); }
  };

  const deleteModule = async (id: number) => {
    if (activeLibraryId == null) return;
    if (!confirm('Delete this module? Its sub-modules, sections and cases move to the library root — nothing is deleted.')) return;
    try {
      await api.modules.delete(id);
      flash('Module deleted; its contents moved to the library root.');
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  const moveModule = async (idx: number, dir: -1 | 1) => {
    if (activeLibraryId == null) return;
    const j = idx + dir;
    if (j < 0 || j >= modules.length) return;
    const next = [...modules];
    [next[idx], next[j]] = [next[j], next[idx]];
    setModules(next);
    try { await api.modules.reorder(next.map((m) => m.id), activeLibraryId); }
    catch (e: any) { setError(e.message); fetchData(activeLibraryId); }
  };

  // ── Sub-module actions ───────────────────────────────────────
  const createSubModule = async () => {
    const name = newSubModuleName.trim();
    if (!name || !addSubAfter || activeLibraryId == null) return;
    try {
      await api.subModules.create(name, activeLibraryId, {
        module_id: addSubAfter.moduleId,
        ...(addSubAfter.afterId != null ? { after_id: addSubAfter.afterId } : {}),
      });
      setNewSubModuleName(''); setAddSubAfter(null);
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };
  const cancelAddSubModule = () => { setAddSubAfter(null); setNewSubModuleName(''); };

  const saveSubModuleName = async () => {
    if (!renameSubModule || activeLibraryId == null) return;
    const name = renameSubModule.name.trim();
    if (!name) return;
    try {
      await api.subModules.update(renameSubModule.id, { name });
      setRenameSubModule(null);
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  const setSubModuleColor = async (id: number, color: SectionColor | null) => {
    const patch = (list: SubModule[]) => list.map((sm) => (sm.id === id ? { ...sm, color } : sm));
    setRootSubModules(patch);
    setModules((prev) => prev.map((m) => ({ ...m, sub_modules: patch(m.sub_modules) })));
    try { await api.subModules.update(id, { color }); }
    catch (e: any) { setError(e.message); if (activeLibraryId != null) fetchData(activeLibraryId); }
  };

  const deleteSubModule = async (id: number) => {
    if (activeLibraryId == null) return;
    if (!confirm('Delete this sub-module? Its sections and cases move up into the parent module — nothing is deleted.')) return;
    try {
      await api.subModules.delete(id);
      flash('Sub-module deleted; its contents moved up a level.');
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  const moveSubModuleInBucket = async (bucket: SubModule[], idx: number, dir: -1 | 1) => {
    if (activeLibraryId == null) return;
    const j = idx + dir;
    if (j < 0 || j >= bucket.length) return;
    const next = [...bucket];
    [next[idx], next[j]] = [next[j], next[idx]];
    await api.subModules.reorder(next.map((sm) => sm.id), activeLibraryId);
    fetchData(activeLibraryId);
  };

  // ── Section actions ──────────────────────────────────────────
  const createSection = async () => {
    if (!newSectionName.trim() || !addAfter || activeLibraryId == null) return;
    const opts = {
      module_id: addAfter.moduleId,
      sub_module_id: addAfter.subModuleId,
      ...(addAfter.afterId != null ? { after_id: addAfter.afterId } : {}),
    };
    await api.sections.create(newSectionName.trim(), activeLibraryId, opts);
    setNewSectionName('');
    setAddAfter(null);
    fetchData(activeLibraryId);
  };

  const cancelAddSection = () => { setAddAfter(null); setNewSectionName(''); };

  const saveSection = async () => {
    if (!editSection?.name.trim() || activeLibraryId == null) return;
    await api.sections.update(editSection.id, { name: editSection.name.trim() });
    setEditSection(null);
    fetchData(activeLibraryId);
  };

  const setSectionColor = async (id: number, color: SectionColor | null) => {
    // Optimistic across whichever bucket the section lives in.
    const patchSecs = (list: Section[]) => list.map((s) => (s.id === id ? { ...s, color } : s));
    setSections(patchSecs);
    const patchSubs = (list: SubModule[]) => list.map((sm) => ({ ...sm, sections: patchSecs(sm.sections) }));
    setRootSubModules(patchSubs);
    setModules((prev) => prev.map((m) => ({ ...m, sections: patchSecs(m.sections), sub_modules: patchSubs(m.sub_modules) })));
    try {
      await api.sections.update(id, { color });
    } catch (e: any) {
      setError(e.message);
      if (activeLibraryId != null) fetchData(activeLibraryId);
    }
  };

  const toggleSectionAndCases = (section: Section) => {
    const caseIds = section.test_cases.map((c) => c.id);
    const secSelected = selSections.has(section.id);
    const allCasesSelected = caseIds.length === 0 || caseIds.every((id) => selCases.has(id));
    const fullyChecked = secSelected && allCasesSelected;
    setSelSections((prev) => { const n = new Set(prev); fullyChecked ? n.delete(section.id) : n.add(section.id); return n; });
    setSelCases((prev) => {
      const n = new Set(prev);
      if (fullyChecked) caseIds.forEach((id) => n.delete(id));
      else caseIds.forEach((id) => n.add(id));
      return n;
    });
  };

  // Selecting a sub-module ticks it plus its sections + all their cases + its
  // unsectioned pile.
  const toggleSubModule = (sm: SubModule) => {
    const secIds = sm.sections.map((s) => s.id);
    const caseIds = [...sm.sections.flatMap((s) => s.test_cases.map((c) => c.id)), ...sm.unsectioned.map((c) => c.id)];
    const fully = selSubModules.has(sm.id)
      && secIds.every((id) => selSections.has(id))
      && caseIds.every((id) => selCases.has(id));
    setSelSubModules((prev) => { const n = new Set(prev); fully ? n.delete(sm.id) : n.add(sm.id); return n; });
    setSelSections((prev) => { const n = new Set(prev); secIds.forEach((id) => (fully ? n.delete(id) : n.add(id))); return n; });
    setSelCases((prev) => { const n = new Set(prev); caseIds.forEach((id) => (fully ? n.delete(id) : n.add(id))); return n; });
  };

  // Selecting a module ticks its whole subtree (sub-modules + sections + cases).
  const toggleModule = (module: Module) => {
    const subIds = module.sub_modules.map((sm) => sm.id);
    const secIds = [...module.sub_modules.flatMap((sm) => sm.sections.map((s) => s.id)), ...module.sections.map((s) => s.id)];
    const caseIds = [
      ...module.sub_modules.flatMap((sm) => [...sm.sections.flatMap((s) => s.test_cases.map((c) => c.id)), ...sm.unsectioned.map((c) => c.id)]),
      ...module.sections.flatMap((s) => s.test_cases.map((c) => c.id)),
      ...module.unsectioned.map((c) => c.id),
    ];
    const fully = selModules.has(module.id)
      && subIds.every((id) => selSubModules.has(id))
      && secIds.every((id) => selSections.has(id))
      && caseIds.every((id) => selCases.has(id));
    setSelModules((prev) => { const n = new Set(prev); fully ? n.delete(module.id) : n.add(module.id); return n; });
    setSelSubModules((prev) => { const n = new Set(prev); subIds.forEach((id) => (fully ? n.delete(id) : n.add(id))); return n; });
    setSelSections((prev) => { const n = new Set(prev); secIds.forEach((id) => (fully ? n.delete(id) : n.add(id))); return n; });
    setSelCases((prev) => { const n = new Set(prev); caseIds.forEach((id) => (fully ? n.delete(id) : n.add(id))); return n; });
  };

  const deleteSection = async (id: number) => {
    if (!confirm('Delete this section? Its test cases stay in the same container as unsectioned.')) return;
    if (activeLibraryId == null) return;
    await api.sections.delete(id);
    fetchData(activeLibraryId);
  };

  // Reorder sections within one bucket (a container's list).
  const moveSectionInBucket = async (bucket: Section[], idx: number, dir: -1 | 1) => {
    if (activeLibraryId == null) return;
    const j = idx + dir;
    if (j < 0 || j >= bucket.length) return;
    const next = [...bucket];
    [next[idx], next[j]] = [next[j], next[idx]];
    await api.sections.reorder(next.map((s) => s.id), activeLibraryId);
    fetchData(activeLibraryId);
  };

  // ── Test case actions ────────────────────────────────────────
  const saveCase = async () => {
    if (!editCase?.desc.trim() || activeLibraryId == null) return;
    await api.testCases.update(editCase.id, { description: editCase.desc.trim(), notes: editCase.notes.trim() || null, section_id: editCase.sectionId });
    setEditCase(null);
    fetchData(activeLibraryId);
  };

  const deleteCase = async (id: number) => {
    if (!confirm('Delete this test case?')) return;
    if (activeLibraryId == null) return;
    await api.testCases.delete(id);
    fetchData(activeLibraryId);
  };

  // Reorder cases within one bucket (a section, or an unsectioned pile).
  const moveCaseInBucket = async (cases: TestCase[], idx: number, dir: -1 | 1) => {
    if (activeLibraryId == null) return;
    const j = idx + dir;
    if (j < 0 || j >= cases.length) return;
    const next = [...cases];
    [next[idx], next[j]] = [next[j], next[idx]];
    await api.testCases.reorder(next.map((c) => c.id), activeLibraryId);
    fetchData(activeLibraryId);
  };

  // ── Add a case or many (paste a list, one case per line) ─────
  const runBulkAdd = async () => {
    if (!bulkAdd || activeLibraryId == null) return;
    const descriptions = bulkAdd.text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (descriptions.length === 0) { setBulkAdd(null); return; }
    try {
      const r = await api.testCases.bulkCreate(bulkAdd.sectionId, descriptions, activeLibraryId, bulkAdd.moduleId, bulkAdd.subModuleId);
      flash(`Added ${r.created} test case(s).`);
      setBulkAdd(null);
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  // ── Selection helpers ────────────────────────────────────────
  const toggleCase = (id: number) =>
    setSelCases((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAllIn = (cases: TestCase[]) =>
    setSelCases((prev) => {
      const n = new Set(prev);
      const all = cases.length > 0 && cases.every((c) => n.has(c.id));
      cases.forEach((c) => (all ? n.delete(c.id) : n.add(c.id)));
      return n;
    });
  const clearSel = () => { setSelCases(new Set()); setSelSections(new Set()); setSelSubModules(new Set()); setSelModules(new Set()); };

  // ── Bulk case operations ─────────────────────────────────────
  // Target encodes the destination bucket: `s:<id>` a section (container derived
  // server-side), `u:<module|root>:<sub|root>` a container's unsectioned pile.
  const bulkMoveCases = async (target: string) => {
    const ids = [...selCases];
    if (ids.length === 0 || activeLibraryId == null || !target) return;
    let sectionId: number | null = null;
    let moduleId: number | null = null;
    let subModuleId: number | null = null;
    let destName = '';
    if (target.startsWith('s:')) {
      sectionId = Number(target.slice(2));
      const found = allSections.find((x) => x.section.id === sectionId);
      destName = found?.section.name ?? 'section';
    } else {
      const [, mod, sub] = target.split(':');
      moduleId = mod === 'root' ? null : Number(mod);
      subModuleId = sub === 'root' ? null : Number(sub);
      const modName = moduleId == null ? 'Library root' : modules.find((m) => m.id === moduleId)?.name ?? 'module';
      const subName = subModuleId == null ? '' : ` › ${allSubModuleName(subModuleId)}`;
      destName = `${modName}${subName} · Unsectioned`;
    }
    try {
      const r = await api.testCases.bulkMove(ids, sectionId, activeLibraryId, moduleId, subModuleId);
      flash(`Moved ${r.moved} test case(s) to ${destName}.`);
      clearSel();
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  const allSubModuleName = (id: number): string => {
    for (const m of modules) { const s = m.sub_modules.find((x) => x.id === id); if (s) return s.name; }
    return rootSubModules.find((x) => x.id === id)?.name ?? 'sub-module';
  };

  const bulkDeleteCases = async () => {
    const ids = [...selCases];
    if (ids.length === 0 || activeLibraryId == null) return;
    if (!confirm(`Delete ${ids.length} test case(s)? This cannot be undone.`)) return;
    try {
      const r = await api.testCases.bulkDelete(ids);
      flash(`Deleted ${r.deleted} test case(s).`);
      clearSel();
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  const bulkDuplicateCases = async () => {
    const ids = [...selCases];
    if (ids.length === 0 || activeLibraryId == null) return;
    try {
      const r = await api.testCases.bulkDuplicate(ids);
      flash(`Duplicated ${r.created} test case(s).`);
      clearSel();
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  const bulkExportCasesPDF = () => {
    const ids = [...selCases];
    if (ids.length === 0 || activeLibraryId == null) return;
    window.open(testCasesPdfUrl(activeLibraryId, ids), '_blank');
  };

  const [copyBusy, setCopyBusy] = useState(false);
  const bulkCopyToLibrary = async (targetLibraryId: number) => {
    const caseIds = [...selCases];
    const sectionIds = [...selSections];
    const subModuleIds = [...selSubModules];
    const moduleIds = [...selModules];
    if ((caseIds.length === 0 && sectionIds.length === 0 && subModuleIds.length === 0 && moduleIds.length === 0) || activeLibraryId == null) return;
    const targetName = libraries.find((l) => l.id === targetLibraryId)?.name ?? 'library';
    setCopyBusy(true);
    try {
      const r = await api.testCases.bulkCopy(targetLibraryId, caseIds, sectionIds, moduleIds, subModuleIds);
      const bits: string[] = [];
      if (r.modulesCreated > 0) bits.push(`${r.modulesCreated} new module${r.modulesCreated > 1 ? 's' : ''}`);
      if (r.subModulesCreated > 0) bits.push(`${r.subModulesCreated} new sub-module${r.subModulesCreated > 1 ? 's' : ''}`);
      if (r.sectionsCreated > 0) bits.push(`${r.sectionsCreated} new section${r.sectionsCreated > 1 ? 's' : ''}`);
      const extra = bits.length ? ` (${bits.join(', ')})` : '';
      flash(`Copied ${r.copiedCases} case${r.copiedCases === 1 ? '' : 's'}${extra} to "${r.library?.name ?? targetName}".`);
      clearSel();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCopyBusy(false);
    }
  };

  // ── Bulk section operations ──────────────────────────────────
  const mergeSections = async (targetId: number) => {
    const sources = [...selSections].filter((id) => id !== targetId);
    if (sources.length === 0 || activeLibraryId == null) { setError('Pick a different target section to merge into.'); return; }
    const targetName = allSections.find((x) => x.section.id === targetId)?.section.name ?? 'section';
    if (!confirm(`Merge ${sources.length} section(s) into "${targetName}"? The emptied sections will be deleted.`)) return;
    try {
      const r = await api.sections.merge([...selSections], targetId);
      flash(`Merged ${r.mergedSections} section(s) into "${targetName}" (${r.movedCases} case(s) moved).`);
      clearSel();
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  const bulkDeleteSections = async () => {
    const ids = [...selSections];
    if (ids.length === 0 || activeLibraryId == null) return;
    if (!confirm(`Delete ${ids.length} section(s)? Their test cases stay in the same container as unsectioned.`)) return;
    try {
      const r = await api.sections.bulkDelete(ids);
      flash(`Deleted ${r.deleted} section(s).`);
      clearSel();
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  // Move the selected sections (with their cases) into a container, or to root.
  // Target: `root`, `m:<id>` (module direct), or `sm:<id>` (a sub-module).
  const moveSectionsToContainer = async (target: string) => {
    const ids = [...selSections];
    if (ids.length === 0 || activeLibraryId == null || !target) return;
    let moduleId: number | null = null;
    let subModuleId: number | null = null;
    let destName = 'the library root';
    if (target.startsWith('m:')) {
      moduleId = Number(target.slice(2));
      destName = `"${modules.find((m) => m.id === moduleId)?.name ?? 'module'}"`;
    } else if (target.startsWith('sm:')) {
      subModuleId = Number(target.slice(3));
      destName = `"${allSubModuleName(subModuleId)}"`;
    }
    try {
      const r = await api.sections.moveModule(ids, activeLibraryId, moduleId, subModuleId);
      flash(`Moved ${r.moved} section(s) to ${destName}.`);
      clearSel();
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  // Move the selected sub-modules (with their content) into a module, or to root.
  const moveSubModulesToModule = async (target: string) => {
    const ids = [...selSubModules];
    if (ids.length === 0 || activeLibraryId == null || !target) return;
    const moduleId = target === 'root' ? null : Number(target);
    const destName = moduleId == null ? 'the library root' : `"${modules.find((m) => m.id === moduleId)?.name ?? 'module'}"`;
    try {
      const r = await api.subModules.moveModule(ids, activeLibraryId, moduleId);
      flash(`Moved ${r.moved} sub-module(s) to ${destName}.`);
      clearSel();
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editCase) return;
    setUploadingImage(true);
    try {
      const { url } = await api.upload.image(file);
      const md = `\n![image](${url})\n`;
      const ta = notesTextareaRef.current;
      const pos = ta ? ta.selectionStart : editCase.notes.length;
      setEditCase({ ...editCase, notes: editCase.notes.slice(0, pos) + md + editCase.notes.slice(pos) });
    } catch (err: any) {
      alert(err?.message || 'Image upload failed');
    } finally {
      setUploadingImage(false);
      e.target.value = '';
    }
  };

  // ── ZIP backup import ────────────────────────────────────────
  const handleBackupFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setMessage('');
    if (!file.name.toLowerCase().endsWith('.zip')) { setError('Please choose a .zip exotick backup file.'); return; }
    setImportFile(file);
  };

  const runImport = async (mode: 'new' | 'merge' | 'replace') => {
    if (!importFile) return;
    if (mode === 'replace' && !confirm(`Replace ALL modules, sub-modules, sections and test cases in "${activeLibrary?.name}" with the backup? This cannot be undone.`)) return;
    setImportBusy(true);
    setError('');
    try {
      const r = await api.backup.import({
        file: importFile,
        mode,
        target_library_id: mode === 'new' ? undefined : activeLibraryId ?? undefined,
      });
      if (mode === 'new') {
        await refreshLibraries();
        setActiveLibrary(r.library.id);
      } else if (activeLibraryId != null) {
        fetchData(activeLibraryId);
      }
      flash(
        `Imported ${r.casesAdded} test case(s) across ${r.sectionsAdded} section(s) into "${r.library.name}"` +
          (r.imagesWritten ? `, restored ${r.imagesWritten} image(s)` : '') + '.'
      );
      setImportFile(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setImportBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent, save: () => void, cancel: () => void) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') cancel();
  };

  // Section targets for the edit-case dropdown + bulk "Move to…" picker,
  // labelled with their container so same-named sections stay distinguishable.
  const sectionOptionLabel = (name: string, moduleName: string | null, subName: string | null) => {
    const path = [moduleName, subName].filter(Boolean).join(' › ');
    return path ? `${path} › ${name}` : name;
  };

  // ── Render cases list ────────────────────────────────────────
  const renderCases = (cases: TestCase[], sectionId: number | null, moduleId: number | null, subModuleId: number | null) => {
    const bulkHere = bulkAdd && bulkAdd.sectionId === sectionId && bulkAdd.moduleId === moduleId && bulkAdd.subModuleId === subModuleId;
    return (
    <div>
      {cases.map((tc, i) => (
        <div key={tc.id} className={`group py-1.5 border-b border-gray-100 last:border-0 flex items-start gap-2 ${selectedId === tc.id ? 'bg-blue-50' : ''}`}>
          <input
            type="checkbox"
            checked={selCases.has(tc.id)}
            onChange={() => toggleCase(tc.id)}
            className="mt-1 cursor-pointer accent-blue-600 shrink-0"
            title="Select test case"
          />
          <div className="flex-1 min-w-0">
          {editCase?.id === tc.id ? (
            <div className="flex flex-col gap-1.5">
              <input
                className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                value={editCase.desc}
                onChange={(e) => setEditCase({ ...editCase, desc: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Escape') setEditCase(null); }}
                autoFocus
              />
              <div className="flex items-center gap-1 mb-0.5">
                <span className="text-xs text-gray-400">Description (markdown)</span>
                <button
                  type="button"
                  disabled={uploadingImage}
                  onClick={() => imageInputRef.current?.click()}
                  className="ml-auto text-xs px-2 py-0.5 border rounded text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Action icon="image" label="Insert image">{uploadingImage ? 'Uploading…' : '+ Insert Image'}</Action>
                </button>
                <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
              </div>
              <textarea
                ref={notesTextareaRef}
                className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y text-gray-600 font-mono"
                rows={5}
                placeholder="Supports markdown — **bold**, _italic_, ![image](url), etc."
                value={editCase.notes}
                onChange={(e) => setEditCase({ ...editCase, notes: e.target.value })}
              />
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400">Section</label>
                <select
                  className="border rounded px-2 py-1 text-sm max-w-[14rem] truncate focus:outline-none focus:ring-1 focus:ring-blue-400"
                  value={editCase.sectionId ?? ''}
                  onChange={(e) => setEditCase({ ...editCase, sectionId: e.target.value === '' ? null : Number(e.target.value) })}
                >
                  <option value="">Unsectioned (keep container)</option>
                  {allSections.map(({ section, moduleName, subName }) => (
                    <option key={section.id} value={section.id}>{sectionOptionLabel(section.name, moduleName, subName)}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <button onClick={saveCase} className="text-green-600 text-xs px-2 py-1 hover:bg-green-50 rounded border border-green-200"><Action icon="save">Save</Action></button>
                <button onClick={() => setEditCase(null)} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedId(tc.id)}
                title="Click to view its description on the right"
                className={`flex-1 min-w-0 text-left text-sm flex items-start gap-1.5 ${selectedId === tc.id ? 'text-blue-600 font-medium' : 'text-gray-700'}`}
              >
                <span className="min-w-0 break-words">{tc.description}</span>
                {tc.notes && <span className="shrink-0 text-gray-300 mt-0.5" title="Has a description">📄</span>}
              </button>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => moveCaseInBucket(cases, i, -1)} disabled={i === 0} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs" title="Move up">▲</button>
                <button onClick={() => moveCaseInBucket(cases, i, 1)} disabled={i === cases.length - 1} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs" title="Move down">▼</button>
                <button
                  onClick={() => setEditCase({ id: tc.id, desc: tc.description, notes: tc.notes ?? '', sectionId })}
                  className="px-2 py-1 text-blue-500 hover:text-blue-700 text-xs"
                ><Action icon="pencil">Edit</Action></button>
                <button
                  onClick={() => deleteCase(tc.id)}
                  className="px-2 py-1 text-red-400 hover:text-red-600 text-xs"
                ><Action icon="trash">Delete</Action></button>
              </div>
            </div>
          )}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3 mt-2">
        {bulkHere ? (
          <div className="flex flex-col gap-1.5 flex-1">
            <span className="text-xs text-gray-400">One test case per line</span>
            <textarea
              className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
              rows={5}
              placeholder={"Valid login works\nInvalid password shows error\nLocked account is blocked"}
              value={bulkAdd!.text}
              onChange={(e) => setBulkAdd({ ...bulkAdd!, text: e.target.value })}
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={runBulkAdd} className="text-green-600 text-xs px-2 py-1 hover:bg-green-50 rounded border border-green-300">
                <Action icon="plus" label="Add cases">Add {bulkAdd!.text.split('\n').map((l) => l.trim()).filter(Boolean).length || ''} case(s)</Action>
              </button>
              <button onClick={() => setBulkAdd(null)} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
            </div>
          </div>
        ) : (
          <>
            <button onClick={() => setBulkAdd({ sectionId, moduleId, subModuleId, text: '' })} className="text-xs text-blue-500 hover:text-blue-700">
              <Action icon="plusPlus" label="Add a case or many">+ add a case or many</Action>
            </button>
            {sectionId !== null && (
              <button
                onClick={() => { setBulkAdd(null); setNewSectionName(''); setAddAfter({ afterId: sectionId, moduleId, subModuleId }); }}
                className="text-xs text-blue-500 hover:text-blue-700"
              >
                <Action icon="plusPlusPlus" label="Add section">+ add section</Action>
              </button>
            )}
          </>
        )}
      </div>
    </div>
    );
  };

  const renderAddSectionForm = () => (
    <div className="bg-white border rounded-lg p-3 flex gap-2">
      <input
        className="flex-1 font-semibold border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
        placeholder="Section name..."
        value={newSectionName}
        onChange={(e) => setNewSectionName(e.target.value)}
        onKeyDown={(e) => onKey(e, createSection, cancelAddSection)}
        autoFocus
      />
      <button onClick={createSection} className="text-green-600 px-3 py-1 hover:bg-green-50 rounded border border-green-300 text-sm"><Action icon="plus">Add</Action></button>
      <button onClick={cancelAddSection} className="text-gray-400 px-3 py-1 hover:bg-gray-100 rounded text-sm"><Action icon="x">Cancel</Action></button>
    </div>
  );

  const renderAddSubModuleForm = () => (
    <div className="submodule-shell submodule-header-plain p-3 flex gap-2">
      <input
        className="flex-1 font-semibold border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
        placeholder="Sub-module name..."
        value={newSubModuleName}
        onChange={(e) => setNewSubModuleName(e.target.value)}
        onKeyDown={(e) => onKey(e, createSubModule, cancelAddSubModule)}
        autoFocus
      />
      <button onClick={createSubModule} className="text-green-600 px-3 py-1 hover:bg-green-50 rounded border border-green-300 text-sm"><Action icon="plus">Add</Action></button>
      <button onClick={cancelAddSubModule} className="text-gray-400 px-3 py-1 hover:bg-gray-100 rounded text-sm"><Action icon="x">Cancel</Action></button>
    </div>
  );

  // One section card — reused at every nesting level. `bucket` is the ordered
  // list the section lives in (for move up/down); moduleId/subModuleId are its
  // container, threaded into the add affordances.
  const renderSectionCard = (section: Section, bucket: Section[], idx: number, moduleId: number | null, subModuleId: number | null) => {
    const caseIds = section.test_cases.map((c) => c.id);
    const secSelected = selSections.has(section.id);
    const allCasesSelected = caseIds.length === 0 || caseIds.every((id) => selCases.has(id));
    const someCasesSelected = caseIds.some((id) => selCases.has(id));
    const fullyChecked = secSelected && allCasesSelected;
    const partial = !fullyChecked && (secSelected || someCasesSelected);
    const tintClass = section.color ? ` section-tint-${section.color}` : '';
    return (
      <div key={section.id}>
        <div className={`bg-white border rounded-lg overflow-hidden ${secSelected ? 'ring-1 ring-blue-400' : ''}`}>
          <div className={`group/sec flex items-center gap-2 px-4 py-3 border-b${tintClass}`}>
            {editSection?.id === section.id ? (
              <>
                <input
                  className="flex-1 font-semibold border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  value={editSection.name}
                  onChange={(e) => setEditSection({ ...editSection, name: e.target.value })}
                  onKeyDown={(e) => onKey(e, saveSection, () => setEditSection(null))}
                  autoFocus
                />
                <button onClick={saveSection} className="text-green-600 text-sm px-2 py-1 hover:bg-green-50 rounded"><Action icon="save">Save</Action></button>
                <button onClick={() => setEditSection(null)} className="text-gray-400 text-sm px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
              </>
            ) : (
              <>
                <TriCheckbox
                  checked={fullyChecked}
                  indeterminate={partial}
                  onChange={() => toggleSectionAndCases(section)}
                  title="Select section and all its cases"
                  className="shrink-0"
                />
                <span className="flex-1 font-semibold text-gray-800">{section.name}</span>
                <span className="text-xs text-gray-400 mr-1">{section.test_cases.length} cases</span>
                <div className="flex items-center gap-0.5 opacity-0 group-hover/sec:opacity-100 focus-within:opacity-100 transition-opacity">
                  <ColorSwatches value={section.color} onPick={(c) => setSectionColor(section.id, c)} />
                  <button onClick={() => moveSectionInBucket(bucket, idx, -1)} disabled={idx === 0} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs" title="Move up">▲</button>
                  <button onClick={() => moveSectionInBucket(bucket, idx, 1)} disabled={idx === bucket.length - 1} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs" title="Move down">▼</button>
                  <button onClick={() => setEditSection({ id: section.id, name: section.name })} className="px-2 py-1 text-blue-500 hover:text-blue-700 text-sm"><Action icon="pencil">Edit</Action></button>
                  <button onClick={() => deleteSection(section.id)} className="px-2 py-1 text-red-400 hover:text-red-600 text-sm"><Action icon="trash">Delete</Action></button>
                </div>
              </>
            )}
          </div>
          <div className="px-4 py-3">
            {renderCases(section.test_cases, section.id, moduleId, subModuleId)}
          </div>
        </div>
        {addAfter?.afterId === section.id && (
          <div className="mt-3">{renderAddSectionForm()}</div>
        )}
      </div>
    );
  };

  // A container's unsectioned pile (module or sub-module). Rendered only when it
  // has cases — the single add affordance for unsectioned lives at the root.
  const renderContainerUnsectioned = (cases: TestCase[], moduleId: number | null, subModuleId: number | null) => {
    if (cases.length === 0) return null;
    const uAll = cases.every((c) => selCases.has(c.id));
    const uSome = cases.some((c) => selCases.has(c.id));
    return (
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <TriCheckbox checked={uAll} indeterminate={uSome} onChange={() => toggleAllIn(cases)} title="Select all unsectioned cases" className="shrink-0" />
          <span className="flex-1 font-semibold text-gray-400">Unsectioned</span>
          <span className="text-xs text-gray-300">{cases.length} cases</span>
        </div>
        <div className="px-4 py-3">{renderCases(cases, null, moduleId, subModuleId)}</div>
      </div>
    );
  };

  // A sub-module card: colored header + its sections + unsectioned pile, plus
  // "add section" / "add sub-module (sibling)" footer affordances.
  const renderSubModuleCard = (sm: SubModule, bucket: SubModule[], idx: number, moduleId: number | null) => {
    const subSelected = selSubModules.has(sm.id);
    const secIds = sm.sections.map((s) => s.id);
    const caseIds = [...sm.sections.flatMap((s) => s.test_cases.map((c) => c.id)), ...sm.unsectioned.map((c) => c.id)];
    const fully = subSelected && secIds.every((id) => selSections.has(id)) && caseIds.every((id) => selCases.has(id));
    const partial = !fully && (subSelected || secIds.some((id) => selSections.has(id)) || caseIds.some((id) => selCases.has(id)));
    const headerTint = sm.color ? `section-tint-${sm.color}` : 'submodule-header-plain';
    return (
      <div key={sm.id}>
        <div className={`submodule-shell overflow-hidden ${subSelected ? 'ring-1 ring-blue-400' : ''}`}>
          <div className={`submodule-header group/sub flex items-center gap-2 px-4 py-2.5 ${headerTint}`}>
            {renameSubModule?.id === sm.id ? (
              <>
                <input
                  className="flex-1 font-semibold border rounded px-2 py-1 text-sm focus:outline-none"
                  value={renameSubModule.name}
                  onChange={(e) => setRenameSubModule({ ...renameSubModule, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveSubModuleName(); if (e.key === 'Escape') setRenameSubModule(null); }}
                  autoFocus
                />
                <button onClick={saveSubModuleName} className="text-green-600 text-xs px-2 py-1 hover:bg-green-50 rounded"><Action icon="save">Save</Action></button>
                <button onClick={() => setRenameSubModule(null)} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
              </>
            ) : (
              <>
                <TriCheckbox checked={fully} indeterminate={partial} onChange={() => toggleSubModule(sm)} title="Select sub-module and all its contents" className="shrink-0" />
                <span className="font-semibold text-sm">{sm.name}</span>
                <span className="text-xs text-gray-500 ml-1">{sm.sections.length} section{sm.sections.length === 1 ? '' : 's'}</span>
                <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/sub:opacity-100 focus-within:opacity-100 transition-opacity">
                  <ColorSwatches value={sm.color} onPick={(c) => setSubModuleColor(sm.id, c)} />
                  <button onClick={() => moveSubModuleInBucket(bucket, idx, -1)} disabled={idx === 0} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs" title="Move up">▲</button>
                  <button onClick={() => moveSubModuleInBucket(bucket, idx, 1)} disabled={idx === bucket.length - 1} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs" title="Move down">▼</button>
                  <button onClick={() => setRenameSubModule({ id: sm.id, name: sm.name })} className="px-2 py-1 text-blue-500 hover:text-blue-700 text-xs"><Action icon="pencil">Rename</Action></button>
                  <button onClick={() => deleteSubModule(sm.id)} className="px-2 py-1 text-red-400 hover:text-red-600 text-xs"><Action icon="trash">Delete</Action></button>
                </div>
              </>
            )}
          </div>
          <div className="p-3 space-y-3">
            {sm.sections.map((s, i) => renderSectionCard(s, sm.sections, i, moduleId, sm.id))}
            {renderContainerUnsectioned(sm.unsectioned, moduleId, sm.id)}
            {addAfter && addAfter.afterId === null && addAfter.moduleId === moduleId && addAfter.subModuleId === sm.id ? (
              renderAddSectionForm()
            ) : (
              <button onClick={() => { setNewSectionName(''); setAddAfter({ afterId: null, moduleId, subModuleId: sm.id }); }} className="text-xs text-blue-500 hover:text-blue-700">
                <Action icon="plusPlusPlus" label="Add section">+ add section</Action>
              </button>
            )}
          </div>
        </div>
        {addSubAfter?.afterId === sm.id && (
          <div className="mt-3">{renderAddSubModuleForm()}</div>
        )}
      </div>
    );
  };

  // ── Render ───────────────────────────────────────────────────
  if (librariesLoading) return <div className="text-gray-400 text-sm">Loading libraries…</div>;
  if (libraries.length === 0 || activeLibraryId == null) {
    return <div className="text-gray-500 text-sm">No libraries found.</div>;
  }
  if (loading) return <div className="text-gray-400 text-sm">Loading library…</div>;

  const caseCount = selCases.size;
  const sectionCount = selSections.size;
  const subModuleCount = selSubModules.size;
  const moduleCount = selModules.size;

  const selected = (() => {
    if (selectedId == null) return null;
    for (const { section, moduleName, subName } of allSections) {
      const tc = section.test_cases.find((c) => c.id === selectedId);
      if (tc) return { tc, sectionName: sectionOptionLabel(section.name, moduleName, subName) };
    }
    const u = allUnsectioned.find((c) => c.id === selectedId);
    return u ? { tc: u, sectionName: 'Unsectioned' } : null;
  })();

  const canDeleteLibrary = libraries.length > 1;
  const isEmpty = modules.length === 0 && rootSubModules.length === 0 && sections.length === 0 && unsectioned.length === 0;

  // "Move cases to…" picker options, grouped by container. <optgroup> can't
  // nest, so a sub-module gets its own group with a "Module › Sub" label.
  const moveTargetOptions = (
    <>
      {modules.map((m) => (
        <optgroup key={`m${m.id}`} label={m.name}>
          <option value={`u:${m.id}:root`}>{m.name} · Unsectioned</option>
          {m.sections.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}
        </optgroup>
      ))}
      {modules.flatMap((m) => m.sub_modules.map((sm) => (
        <optgroup key={`m${m.id}sm${sm.id}`} label={`${m.name} › ${sm.name}`}>
          <option value={`u:${m.id}:${sm.id}`}>{sm.name} · Unsectioned</option>
          {sm.sections.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}
        </optgroup>
      )))}
      {rootSubModules.map((sm) => (
        <optgroup key={`sm${sm.id}`} label={sm.name}>
          <option value={`u:root:${sm.id}`}>{sm.name} · Unsectioned</option>
          {sm.sections.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}
        </optgroup>
      ))}
      <optgroup label="Library root">
        <option value="u:root:root">Unsectioned</option>
        {sections.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}
      </optgroup>
    </>
  );
  const mergeTargetOptions = allSections.map(({ section, moduleName, subName }) => (
    <option key={section.id} value={section.id}>{sectionOptionLabel(section.name, moduleName, subName)}</option>
  ));
  // "Move sections to…" container options.
  const sectionMoveTargetOptions = (
    <>
      {modules.map((m) => <option key={`m${m.id}`} value={`m:${m.id}`}>{m.name}</option>)}
      {modules.flatMap((m) => m.sub_modules.map((sm) => <option key={`sm${sm.id}`} value={`sm:${sm.id}`}>{m.name} › {sm.name}</option>))}
      {rootSubModules.map((sm) => <option key={`sm${sm.id}`} value={`sm:${sm.id}`}>{sm.name}</option>)}
      <option value="root">Library root (no container)</option>
    </>
  );

  return (
    <>
      {/* Library toolbar */}
      <div className="flex items-center gap-2 flex-wrap mb-3 text-sm">
        <span className="text-xs uppercase tracking-wide text-gray-400">Library</span>
        {renameLibName !== null ? (
          <>
            <input
              className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              value={renameLibName}
              onChange={(e) => setRenameLibName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveLibraryName(); if (e.key === 'Escape') setRenameLibName(null); }}
              autoFocus
            />
            <button onClick={saveLibraryName} className="text-green-600 text-xs px-2 py-1 hover:bg-green-50 rounded border border-green-300"><Action icon="save">Save</Action></button>
            <button onClick={() => setRenameLibName(null)} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
          </>
        ) : (
          <LibraryPicker />
        )}
        {activeLibrary && renameLibName === null && (
          <>
            <button onClick={() => setRenameLibName(activeLibrary.name)} className="text-xs px-2 py-1 border rounded text-gray-600 hover:bg-gray-50" title="Rename this library">
              <Action icon="pencil">Rename</Action>
            </button>
            <button
              onClick={openDeleteLibrary}
              disabled={!canDeleteLibrary}
              title={canDeleteLibrary ? 'Delete this library' : 'At least one library must exist'}
              className="text-xs px-2 py-1 border border-red-200 rounded text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Action icon="trash">Delete</Action>
            </button>
          </>
        )}
        {newLibName !== null ? (
          <>
            <input
              className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              placeholder="New library name"
              value={newLibName}
              onChange={(e) => setNewLibName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createLibrary(); if (e.key === 'Escape') setNewLibName(null); }}
              autoFocus
            />
            <button onClick={createLibrary} className="text-green-600 text-xs px-2 py-1 hover:bg-green-50 rounded border border-green-300"><Action icon="plus">Add</Action></button>
            <button onClick={() => setNewLibName(null)} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
          </>
        ) : (
          <button onClick={() => setNewLibName('')} className="text-xs px-2 py-1 text-blue-600 hover:text-blue-800">
            <Action icon="plus" label="New library">+ New library</Action>
          </button>
        )}
      </div>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Edit Mode</h1>
        <div className="flex items-center gap-2">
          {canBackup && (
            <>
              <a href={backupExportUrl(activeLibraryId)} className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded text-gray-600" title="Download a backup .zip of this library">
                <Action icon="download">Export Backup</Action>
              </a>
              <button onClick={() => backupInputRef.current?.click()} className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded text-gray-600" title="Restore or import a backup .zip file">
                <Action icon="upload">Import Backup</Action>
              </button>
              <input ref={backupInputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={handleBackupFile} />
            </>
          )}
          <a href={testCasesPdfUrl(activeLibraryId)} target="_blank" className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded text-gray-600">
            <Action icon="download">Export PDF</Action>
          </a>
        </div>
      </div>

    <div className="flex gap-6">
      <div className="w-3/5 min-w-0">

      {/* Bulk action bar */}
      {(caseCount > 0 || sectionCount > 0 || subModuleCount > 0 || moduleCount > 0) && (
        <div className="sticky top-0 z-30 -mx-1 mb-4 bg-white border rounded-lg shadow-sm px-3 py-2 flex flex-col gap-2">
          {caseCount > 0 && (
            <div className="flex items-center flex-wrap gap-2 text-sm">
              <span className="font-semibold text-gray-700">{caseCount} case{caseCount > 1 ? 's' : ''} selected</span>
              <select
                value=""
                onChange={(e) => { if (e.target.value) bulkMoveCases(e.target.value); }}
                className="border rounded px-2 py-1 text-sm text-gray-600 max-w-[12rem] truncate focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                <option value="" disabled hidden>Move to…</option>
                {moveTargetOptions}
              </select>
              <button onClick={bulkDuplicateCases} className="px-2 py-1 rounded text-blue-600 hover:bg-blue-50 border border-blue-200 text-xs"><Action icon="copy">Duplicate</Action></button>
              <button onClick={bulkExportCasesPDF} className="px-2 py-1 rounded text-gray-600 hover:bg-gray-100 border border-gray-200 text-xs"><Action icon="download">Export PDF</Action></button>
              <button onClick={bulkDeleteCases} className="px-2 py-1 rounded text-red-600 hover:bg-red-50 border border-red-200 text-xs"><Action icon="trash">Delete</Action></button>
            </div>
          )}
          {sectionCount > 0 && (
            <div className="flex items-center flex-wrap gap-2 text-sm">
              <span className="font-semibold text-gray-700">{sectionCount} section{sectionCount > 1 ? 's' : ''} selected</span>
              <select
                value=""
                onChange={(e) => { if (e.target.value) mergeSections(Number(e.target.value)); }}
                className="border rounded px-2 py-1 text-sm text-gray-600 max-w-[11rem] truncate focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                <option value="" disabled hidden>Merge into…</option>
                {mergeTargetOptions}
              </select>
              <select
                value=""
                onChange={(e) => { if (e.target.value) moveSectionsToContainer(e.target.value); }}
                className="border rounded px-2 py-1 text-sm text-gray-600 max-w-[13rem] truncate focus:outline-none focus:ring-1 focus:ring-blue-400"
                title="Move the selected sections into a module / sub-module (or the library root)"
              >
                <option value="" disabled hidden>Move to container…</option>
                {sectionMoveTargetOptions}
              </select>
              <button onClick={bulkDeleteSections} className="px-2 py-1 rounded text-red-600 hover:bg-red-50 border border-red-200 text-xs"><Action icon="trash">Delete</Action></button>
            </div>
          )}
          {subModuleCount > 0 && (
            <div className="flex items-center flex-wrap gap-2 text-sm">
              <span className="font-semibold text-gray-700">{subModuleCount} sub-module{subModuleCount > 1 ? 's' : ''} selected</span>
              <select
                value=""
                onChange={(e) => { if (e.target.value) moveSubModulesToModule(e.target.value); }}
                className="border rounded px-2 py-1 text-sm text-gray-600 max-w-[12rem] truncate focus:outline-none focus:ring-1 focus:ring-blue-400"
                title="Move the selected sub-modules into a module (or the library root)"
              >
                <option value="" disabled hidden>Move to module…</option>
                {modules.map((m) => <option key={m.id} value={String(m.id)}>{m.name}</option>)}
                <option value="root">Library root (no module)</option>
              </select>
              <span className="text-xs text-gray-400">their sections + cases are included in a copy</span>
            </div>
          )}
          {moduleCount > 0 && (
            <div className="flex items-center flex-wrap gap-2 text-sm">
              <span className="font-semibold text-gray-700">{moduleCount} module{moduleCount > 1 ? 's' : ''} selected</span>
              <span className="text-xs text-gray-400">their sub-modules, sections + cases are included in a copy</span>
            </div>
          )}
          {libraries.length > 1 && (
            <div className="flex items-center flex-wrap gap-2 text-sm border-t pt-2">
              <span className="text-gray-600">Copy selection to another library</span>
              <select
                value=""
                disabled={copyBusy}
                onChange={(e) => { if (e.target.value) bulkCopyToLibrary(Number(e.target.value)); }}
                className="border rounded px-2 py-1 text-sm text-gray-600 max-w-[12rem] truncate focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50"
                title="Copy the selected modules, sub-modules, sections and cases into another library"
              >
                <option value="" disabled hidden>{copyBusy ? 'Copying…' : 'Copy to…'}</option>
                {libraries.filter((l) => l.id !== activeLibraryId).map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
          )}
          <button onClick={clearSel} className="self-start text-xs text-gray-400 hover:text-gray-600"><Action icon="deselect">Clear selection</Action></button>
        </div>
      )}

      {error && <div className="text-red-600 text-sm mb-4">{error}</div>}
      {message && <div className="text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 text-sm mb-4">{message}</div>}

      {/* Delete-library confirmation */}
      {deleteLibOpen && activeLibrary && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={closeDeleteLibrary}>
          <form onSubmit={(e) => { e.preventDefault(); confirmDeleteLibrary(); }} className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-2xl mb-1">⚠️</div>
            <h2 className="text-lg font-bold text-gray-800 mb-2 break-words">Delete library "{activeLibrary.name}"?</h2>
            <p className="text-sm text-gray-700 mb-3">
              Be careful, you're about to delete an entire library! All modules, sub-modules, sections and cases will disappear!
              Are you <span className="font-bold">REALLY</span> sure?
            </p>
            <p className="text-xs text-gray-500 mb-2">Type <span className="font-mono font-bold text-gray-700">REALLY</span> below to confirm.</p>
            <input
              autoFocus
              type="text"
              value={deleteLibTyped}
              onChange={(e) => { setDeleteLibTyped(e.target.value); setDeleteLibError(''); }}
              onPaste={(e) => { e.preventDefault(); setDeleteLibError('Type it out — pasting is disabled.'); }}
              onDrop={(e) => e.preventDefault()}
              onDragOver={(e) => e.preventDefault()}
              autoComplete="off"
              placeholder="Type REALLY"
              className="w-full border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-red-400"
            />
            {deleteLibError && <div className="text-red-600 text-sm mt-2">{deleteLibError}</div>}
            <div className="flex gap-2 mt-4">
              <button type="submit" disabled={deleteLibBusy || deleteLibTyped !== 'REALLY'} className="flex-1 px-3 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-40 disabled:cursor-not-allowed">
                <Action icon="trash" label="Delete library">{deleteLibBusy ? 'Deleting…' : 'Delete library'}</Action>
              </button>
              <button type="button" onClick={closeDeleteLibrary} disabled={deleteLibBusy} className="px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded disabled:opacity-50">
                <Action icon="x">Cancel</Action>
              </button>
            </div>
          </form>
        </div>
      )}

      {importFile && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => !importBusy && setImportFile(null)}>
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-800 mb-2">Import backup</h2>
            <p className="text-sm text-gray-600 mb-1">Selected archive:</p>
            <p className="text-sm text-gray-700 font-mono break-all mb-4">{importFile.name}</p>
            <p className="text-sm text-gray-600 mb-4">Choose an action:</p>
            <div className="flex flex-col gap-2">
              <button onClick={() => runImport('new')} disabled={importBusy} className="w-full px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 text-left">
                <span className="font-semibold">Create new library</span> — leaves existing libraries untouched
              </button>
              <button onClick={() => runImport('merge')} disabled={importBusy} className="w-full px-3 py-2 text-sm border border-blue-600 text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50 text-left">
                <span className="font-semibold">Merge into "{activeLibrary?.name}"</span> — append to the current library
              </button>
              <button onClick={() => runImport('replace')} disabled={importBusy} className="w-full px-3 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50 text-left">
                <span className="font-semibold">Replace "{activeLibrary?.name}"</span> — wipe the current library, then restore
              </button>
              <button onClick={() => setImportFile(null)} disabled={importBusy} className="w-full px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded disabled:opacity-50">
                <Action icon="x">Cancel</Action>
              </button>
            </div>
            {importBusy && <div className="text-xs text-gray-400 mt-3">Importing…</div>}
          </div>
        </div>
      )}

      {/* Empty-state welcome */}
      {isEmpty && (
        <div className="mb-3 bg-white border rounded-lg p-6 text-center">
          {addAfter && addAfter.afterId === null && addAfter.moduleId === null && addAfter.subModuleId === null ? (
            renderAddSectionForm()
          ) : (
            <>
              <div className="text-3xl mb-2">📋</div>
              <h2 className="text-base font-semibold text-gray-800 mb-1">This library is empty</h2>
              <p className="text-sm text-gray-500 mb-4">
                Start from scratch, or load a small demo set into a new library to see how modules, sub-modules, sections and cases work together.
              </p>
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={async () => {
                    try {
                      const r = await api.samples.load();
                      await refreshLibraries();
                      setActiveLibrary(r.library.id);
                      flash(`Created "${r.library.name}" with ${r.casesAdded} sample case(s) across ${r.sectionsAdded} section(s).`);
                    } catch (e: any) { setError(e.message); }
                  }}
                  className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded"
                >
                  <Action icon="sparkles">Load sample data</Action>
                </button>
                <button onClick={() => { setNewModuleAfter(null); setNewModuleName(''); }} className="px-3 py-1.5 text-sm border border-gray-300 hover:bg-gray-50 rounded text-gray-700">
                  <Action icon="plus" label="Add module">+ Add module</Action>
                </button>
                <button onClick={() => { setNewSectionName(''); setAddAfter({ afterId: null, moduleId: null, subModuleId: null }); }} className="px-3 py-1.5 text-sm border border-gray-300 hover:bg-gray-50 rounded text-gray-700">
                  <Action icon="plusPlusPlus" label="Add section">+ Add section</Action>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="space-y-4">
        {/* Modules */}
        {modules.map((m, mIdx) => {
          const subIds = m.sub_modules.map((sm) => sm.id);
          const secIds = [...m.sub_modules.flatMap((sm) => sm.sections.map((s) => s.id)), ...m.sections.map((s) => s.id)];
          const caseIds = [
            ...m.sub_modules.flatMap((sm) => [...sm.sections.flatMap((s) => s.test_cases.map((c) => c.id)), ...sm.unsectioned.map((c) => c.id)]),
            ...m.sections.flatMap((s) => s.test_cases.map((c) => c.id)),
            ...m.unsectioned.map((c) => c.id),
          ];
          const modSelected = selModules.has(m.id);
          const allChildren = subIds.every((id) => selSubModules.has(id)) && secIds.every((id) => selSections.has(id)) && caseIds.every((id) => selCases.has(id));
          const fully = modSelected && allChildren;
          const partial = !fully && (modSelected || subIds.some((id) => selSubModules.has(id)) || secIds.some((id) => selSections.has(id)) || caseIds.some((id) => selCases.has(id)));
          const headerTint = m.color ? `section-tint-${m.color}` : 'module-header-plain';
          return (
            <div key={m.id}>
            <div className={`module-shell overflow-hidden ${modSelected ? 'ring-1 ring-blue-400' : ''}`}>
              <div className={`module-header group/mod flex items-center gap-2 px-4 py-2.5 ${headerTint}`}>
                {renameModule?.id === m.id ? (
                  <>
                    <input
                      className="flex-1 font-bold border rounded px-2 py-1 text-sm focus:outline-none"
                      value={renameModule.name}
                      onChange={(e) => setRenameModule({ ...renameModule, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveModuleName(); if (e.key === 'Escape') setRenameModule(null); }}
                      autoFocus
                    />
                    <button onClick={saveModuleName} className="text-green-600 text-xs px-2 py-1 hover:bg-green-50 rounded"><Action icon="save">Save</Action></button>
                    <button onClick={() => setRenameModule(null)} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
                  </>
                ) : (
                  <>
                    <TriCheckbox checked={fully} indeterminate={partial} onChange={() => toggleModule(m)} title="Select module and all its contents" className="shrink-0" />
                    <span className="font-bold tracking-wide text-sm">{m.name}</span>
                    <span className="text-xs text-gray-500 ml-1">{m.sub_modules.length} sub-module{m.sub_modules.length === 1 ? '' : 's'}</span>
                    <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/mod:opacity-100 focus-within:opacity-100 transition-opacity">
                      <ColorSwatches value={m.color} onPick={(c) => setModuleColor(m.id, c)} />
                      <button onClick={() => moveModule(mIdx, -1)} disabled={mIdx === 0} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs" title="Move up">▲</button>
                      <button onClick={() => moveModule(mIdx, 1)} disabled={mIdx === modules.length - 1} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs" title="Move down">▼</button>
                      <button onClick={() => setRenameModule({ id: m.id, name: m.name })} className="px-2 py-1 text-xs text-blue-500 hover:text-blue-700"><Action icon="pencil">Rename</Action></button>
                      <button onClick={() => deleteModule(m.id)} className="px-2 py-1 text-xs text-red-400 hover:text-red-600"><Action icon="trash">Delete</Action></button>
                    </div>
                  </>
                )}
              </div>
              <div className="p-3 space-y-3">
                {m.sub_modules.map((sm, i) => renderSubModuleCard(sm, m.sub_modules, i, m.id))}
                {/* Add sub-module (append) */}
                {addSubAfter && addSubAfter.afterId === null && addSubAfter.moduleId === m.id ? (
                  renderAddSubModuleForm()
                ) : null}
                {m.sections.map((s, i) => renderSectionCard(s, m.sections, i, m.id, null))}
                {renderContainerUnsectioned(m.unsectioned, m.id, null)}
                {addAfter && addAfter.afterId === null && addAfter.moduleId === m.id && addAfter.subModuleId === null && (
                  <div>{renderAddSectionForm()}</div>
                )}
                <div className="flex items-center gap-3">
                  <button onClick={() => { setNewSubModuleName(''); setAddSubAfter({ afterId: null, moduleId: m.id }); }} className="text-xs text-blue-500 hover:text-blue-700">
                    <Action icon="plusPlus" label="Add sub-module">+ add sub-module</Action>
                  </button>
                  <button onClick={() => { setNewSectionName(''); setAddAfter({ afterId: null, moduleId: m.id, subModuleId: null }); }} className="text-xs text-blue-500 hover:text-blue-700">
                    <Action icon="plusPlusPlus" label="Add section">+ add section</Action>
                  </button>
                </div>
              </div>
            </div>
            {/* Add module (sibling after this one) */}
            {newModuleName !== null && newModuleAfter === m.id ? (
              <div className="module-shell module-header-plain overflow-hidden mt-3">
                <div className="module-header flex items-center gap-2 px-4 py-2.5">
                  <input
                    className="flex-1 font-bold border rounded px-2 py-1 text-sm focus:outline-none"
                    placeholder="New module name"
                    value={newModuleName}
                    onChange={(e) => setNewModuleName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') createModule(); if (e.key === 'Escape') { setNewModuleName(null); setNewModuleAfter(null); } }}
                    autoFocus
                  />
                  <button onClick={createModule} className="text-green-600 text-xs px-2 py-1 hover:bg-green-50 rounded"><Action icon="plus">Add</Action></button>
                  <button onClick={() => { setNewModuleName(null); setNewModuleAfter(null); }} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
                </div>
              </div>
            ) : (
              <div className="mt-2">
                <button onClick={() => { setNewModuleAfter(m.id); setNewModuleName(''); }} className="text-xs text-blue-500 hover:text-blue-700">
                  <Action icon="plus" label="Add module">+ add module</Action>
                </button>
              </div>
            )}
            </div>
          );
        })}

        {/* + New module (append at end) */}
        {newModuleName !== null && newModuleAfter === null ? (
          <div className="module-shell module-header-plain overflow-hidden">
            <div className="module-header flex items-center gap-2 px-4 py-2.5">
              <input
                className="flex-1 font-bold border rounded px-2 py-1 text-sm focus:outline-none"
                placeholder="New module name"
                value={newModuleName}
                onChange={(e) => setNewModuleName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createModule(); if (e.key === 'Escape') setNewModuleName(null); }}
                autoFocus
              />
              <button onClick={createModule} className="text-green-600 text-xs px-2 py-1 hover:bg-green-50 rounded"><Action icon="plus">Add</Action></button>
              <button onClick={() => setNewModuleName(null)} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
            </div>
          </div>
        ) : (
          !isEmpty && (
            <button onClick={() => { setNewModuleAfter(null); setNewModuleName(''); }} className="text-xs text-blue-500 hover:text-blue-700">
              <Action icon="plus" label="New module">+ New module</Action>
            </button>
          )
        )}

        {/* Root sub-modules */}
        {rootSubModules.map((sm, i) => renderSubModuleCard(sm, rootSubModules, i, null))}
        {addSubAfter && addSubAfter.afterId === null && addSubAfter.moduleId === null && (
          <div>{renderAddSubModuleForm()}</div>
        )}
        {!isEmpty && (
          <button onClick={() => { setNewSubModuleName(''); setAddSubAfter({ afterId: null, moduleId: null }); }} className="text-xs text-blue-500 hover:text-blue-700">
            <Action icon="plusPlus" label="Add sub-module">+ add sub-module</Action>
          </button>
        )}

        {/* Root sections */}
        {!isEmpty && sections.length === 0 && (
          <div>
            {addAfter && addAfter.afterId === null && addAfter.moduleId === null && addAfter.subModuleId === null ? (
              renderAddSectionForm()
            ) : (
              <button onClick={() => { setNewSectionName(''); setAddAfter({ afterId: null, moduleId: null, subModuleId: null }); }} className="text-xs text-blue-500 hover:text-blue-700">
                <Action icon="plusPlusPlus" label="Add section">+ add section</Action>
              </button>
            )}
          </div>
        )}

        {sections.map((s, i) => renderSectionCard(s, sections, i, null, null))}

        {/* Root unsectioned — the only place to add unsectioned cases */}
        {(unsectioned.length > 0 || (bulkAdd?.sectionId === null && bulkAdd.moduleId === null && bulkAdd.subModuleId === null)) && (() => {
          const uAll = unsectioned.length > 0 && unsectioned.every((c) => selCases.has(c.id));
          const uSome = unsectioned.some((c) => selCases.has(c.id));
          return (
            <div className="bg-white border rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b">
                {unsectioned.length > 0 && (
                  <TriCheckbox checked={uAll} indeterminate={uSome} onChange={() => toggleAllIn(unsectioned)} title="Select all unsectioned cases" className="shrink-0" />
                )}
                <span className="flex-1 font-semibold text-gray-400">Unsectioned</span>
                <span className="text-xs text-gray-300">{unsectioned.length} cases</span>
              </div>
              <div className="px-4 py-3">{renderCases(unsectioned, null, null, null)}</div>
            </div>
          );
        })()}

        {!isEmpty && unsectioned.length === 0 && !(bulkAdd?.sectionId === null && bulkAdd.moduleId === null && bulkAdd.subModuleId === null) && (
          <div className="flex items-center gap-3">
            <button onClick={() => setBulkAdd({ sectionId: null, moduleId: null, subModuleId: null, text: '' })} className="text-xs text-gray-400 hover:text-gray-600">
              <Action icon="plusPlus" label="Add unsectioned case or many">+ add unsectioned case or many</Action>
            </button>
          </div>
        )}
      </div>
      </div>

      {/* Right — description preview panel */}
      <div className="w-2/5 min-w-0 sticky top-0 self-start">
        <div className="bg-white border rounded-lg overflow-hidden min-h-[200px]">
          {selected ? (
            <div>
              <div className="px-4 py-3 border-b bg-gray-50">
                <p className="text-sm font-medium text-gray-800 break-words">{selected.tc.description}</p>
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
