import { useEffect, useRef, useState, KeyboardEvent } from 'react';
import { api, backupExportUrl, testCasesPdfUrl } from '../api';
import MarkdownView from '../components/MarkdownView';
import LibraryPicker from '../library/LibraryPicker';
import Action from '../iconmode/Action';
import { useAuth } from '../auth/AuthContext';
import { useLibrary } from '../library/LibraryContext';
import type { Module, Section, SectionColor, TestCase } from '../types';

const SECTION_COLORS: readonly SectionColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

// Add/bulk-add and add-section state carry the (sectionId, moduleId) bucket so
// the affordances resolve to the right place — a null sectionId is ambiguous
// (root vs. a module's unsectioned pile) without the moduleId.
type AddCaseState = { sectionId: number | null; moduleId: number | null; desc: string } | null;
type BulkAddState = { sectionId: number | null; moduleId: number | null; text: string } | null;
type EditCaseState = { id: number; desc: string; notes: string; sectionId: number | null } | null;
type EditSectionState = { id: number; name: string } | null;
type AddAfterState = { afterId: number | null; moduleId: number | null } | null;

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

export default function EditMode() {
  const { user } = useAuth();
  const { libraries, activeLibrary, activeLibraryId, setActiveLibrary, refresh: refreshLibraries, isLoading: librariesLoading } = useLibrary();
  // Backup buttons are admin-only (see routes/backup.ts guard).
  const canBackup = user?.role === 'admin';
  const [modules, setModules] = useState<Module[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [unsectioned, setUnsectioned] = useState<TestCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [editSection, setEditSection] = useState<EditSectionState>(null);
  const [addAfter, setAddAfter] = useState<AddAfterState>(null);
  const [newSectionName, setNewSectionName] = useState('');

  const [editCase, setEditCase] = useState<EditCaseState>(null);
  const [addCase, setAddCase] = useState<AddCaseState>(null);
  const [bulkAdd, setBulkAdd] = useState<BulkAddState>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const notesTextareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const [selCases, setSelCases] = useState<Set<number>>(new Set());
  const [selSections, setSelSections] = useState<Set<number>>(new Set());
  const [selModules, setSelModules] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const backupInputRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  // Module-management UI state (inline, like the library toolbar).
  const [newModuleName, setNewModuleName] = useState<string | null>(null);
  const [renameModule, setRenameModule] = useState<{ id: number; name: string } | null>(null);

  // Library-management UI state — inline in the header, not modals.
  const [newLibName, setNewLibName] = useState<string | null>(null);
  const [renameLibName, setRenameLibName] = useState<string | null>(null);
  const [deleteLibOpen, setDeleteLibOpen] = useState(false);
  const [deleteLibTyped, setDeleteLibTyped] = useState('');
  const [deleteLibBusy, setDeleteLibBusy] = useState(false);
  const [deleteLibError, setDeleteLibError] = useState('');

  // Flattened views across modules + root — used for target pickers, the
  // preview lookup, and selection reconciliation.
  const allSections: { section: Section; moduleName: string | null }[] = [
    ...modules.flatMap((m) => m.sections.map((s) => ({ section: s, moduleName: m.name }))),
    ...sections.map((s) => ({ section: s, moduleName: null })),
  ];
  const allUnsectioned: TestCase[] = [...modules.flatMap((m) => m.unsectioned), ...unsectioned];

  const fetchData = async (libId: number) => {
    try {
      const { modules: m, sections: s, unsectioned: u } = await api.sections.list(libId);
      setModules(m);
      setSections(s);
      setUnsectioned(u);
      // Drop any selected ids that no longer exist.
      const flatSecs = [...m.flatMap((x) => x.sections), ...s];
      const caseIds = new Set<number>([
        ...flatSecs.flatMap((x) => x.test_cases.map((c) => c.id)),
        ...m.flatMap((x) => x.unsectioned.map((c) => c.id)),
        ...u.map((c) => c.id),
      ]);
      const secIds = new Set<number>(flatSecs.map((x) => x.id));
      const modIds = new Set<number>(m.map((x) => x.id));
      setSelCases((prev) => new Set([...prev].filter((id) => caseIds.has(id))));
      setSelSections((prev) => new Set([...prev].filter((id) => secIds.has(id))));
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
    setEditCase(null); setAddCase(null); setBulkAdd(null);
    setEditSection(null); setAddAfter(null); setNewSectionName('');
    setNewModuleName(null); setRenameModule(null);
    setSelCases(new Set()); setSelSections(new Set()); setSelModules(new Set()); setSelectedId(null);
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
      await api.modules.create(name, activeLibraryId);
      setNewModuleName(null);
      fetchData(activeLibraryId);
      flash(`Created module "${name}".`);
    } catch (e: any) { setError(e.message); }
  };

  const saveModuleName = async () => {
    if (!renameModule || activeLibraryId == null) return;
    const name = renameModule.name.trim();
    if (!name) return;
    try {
      await api.modules.rename(renameModule.id, name);
      setRenameModule(null);
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  const deleteModule = async (id: number) => {
    if (activeLibraryId == null) return;
    if (!confirm('Delete this module? Its sections and cases move to the library root — nothing is deleted.')) return;
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

  // ── Section actions ──────────────────────────────────────────
  const createSection = async () => {
    if (!newSectionName.trim() || !addAfter || activeLibraryId == null) return;
    const opts = { module_id: addAfter.moduleId, ...(addAfter.afterId != null ? { after_id: addAfter.afterId } : {}) };
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
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, color } : s)));
    setModules((prev) => prev.map((m) => ({ ...m, sections: m.sections.map((s) => (s.id === id ? { ...s, color } : s)) })));
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

  // Selecting a module selects it plus every descendant (its sections + all
  // their cases + its module-level unsectioned cases), so "copy a whole
  // module" carries the full subtree.
  const toggleModule = (module: Module) => {
    const secIds = module.sections.map((s) => s.id);
    const caseIds = [...module.sections.flatMap((s) => s.test_cases.map((c) => c.id)), ...module.unsectioned.map((c) => c.id)];
    const fully = selModules.has(module.id)
      && secIds.every((id) => selSections.has(id))
      && caseIds.every((id) => selCases.has(id));
    setSelModules((prev) => { const n = new Set(prev); fully ? n.delete(module.id) : n.add(module.id); return n; });
    setSelSections((prev) => { const n = new Set(prev); secIds.forEach((id) => (fully ? n.delete(id) : n.add(id))); return n; });
    setSelCases((prev) => { const n = new Set(prev); caseIds.forEach((id) => (fully ? n.delete(id) : n.add(id))); return n; });
  };

  const deleteSection = async (id: number) => {
    if (!confirm('Delete this section? Its test cases stay in the same module as unsectioned.')) return;
    if (activeLibraryId == null) return;
    await api.sections.delete(id);
    fetchData(activeLibraryId);
  };

  // Reorder sections within one bucket (a module's list, or the root list).
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
  const createCase = async () => {
    if (!addCase?.desc.trim() || activeLibraryId == null) return;
    await api.testCases.create({ section_id: addCase.sectionId, module_id: addCase.moduleId, description: addCase.desc.trim(), library_id: activeLibraryId });
    setAddCase(null);
    fetchData(activeLibraryId);
  };

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

  // Reorder cases within one bucket (a section, or a module/root unsectioned
  // pile). The client sends that bucket's ordered ids.
  const moveCaseInBucket = async (cases: TestCase[], idx: number, dir: -1 | 1) => {
    if (activeLibraryId == null) return;
    const j = idx + dir;
    if (j < 0 || j >= cases.length) return;
    const next = [...cases];
    [next[idx], next[j]] = [next[j], next[idx]];
    await api.testCases.reorder(next.map((c) => c.id), activeLibraryId);
    fetchData(activeLibraryId);
  };

  // ── Bulk add (paste a list, one case per line) ───────────────
  const runBulkAdd = async () => {
    if (!bulkAdd || activeLibraryId == null) return;
    const descriptions = bulkAdd.text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (descriptions.length === 0) { setBulkAdd(null); return; }
    try {
      const r = await api.testCases.bulkCreate(bulkAdd.sectionId, descriptions, activeLibraryId, bulkAdd.moduleId);
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
  const clearSel = () => { setSelCases(new Set()); setSelSections(new Set()); setSelModules(new Set()); };

  // ── Bulk case operations ─────────────────────────────────────
  // Target encodes the destination bucket: `s:<id>` a section (module derived
  // server-side), `u:<moduleId|root>` a module's / the root's unsectioned pile.
  const bulkMoveCases = async (target: string) => {
    const ids = [...selCases];
    if (ids.length === 0 || activeLibraryId == null || !target) return;
    let sectionId: number | null = null;
    let moduleId: number | null = null;
    let destName = '';
    if (target.startsWith('s:')) {
      sectionId = Number(target.slice(2));
      destName = allSections.find((x) => x.section.id === sectionId)?.section.name ?? 'section';
    } else {
      const rest = target.slice(2);
      moduleId = rest === 'root' ? null : Number(rest);
      const modName = moduleId == null ? 'Library root' : modules.find((m) => m.id === moduleId)?.name ?? 'module';
      destName = `${modName} · Unsectioned`;
    }
    try {
      const r = await api.testCases.bulkMove(ids, sectionId, activeLibraryId, moduleId);
      flash(`Moved ${r.moved} test case(s) to ${destName}.`);
      clearSel();
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
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
    const moduleIds = [...selModules];
    if ((caseIds.length === 0 && sectionIds.length === 0 && moduleIds.length === 0) || activeLibraryId == null) return;
    const targetName = libraries.find((l) => l.id === targetLibraryId)?.name ?? 'library';
    setCopyBusy(true);
    try {
      const r = await api.testCases.bulkCopy(targetLibraryId, caseIds, sectionIds, moduleIds);
      const bits: string[] = [];
      if (r.modulesCreated > 0) bits.push(`${r.modulesCreated} new module${r.modulesCreated > 1 ? 's' : ''}`);
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
    if (!confirm(`Delete ${ids.length} section(s)? Their test cases stay in the same module as unsectioned.`)) return;
    try {
      const r = await api.sections.bulkDelete(ids);
      flash(`Deleted ${r.deleted} section(s).`);
      clearSel();
      fetchData(activeLibraryId);
    } catch (e: any) { setError(e.message); }
  };

  // Move the selected sections (with their cases) into a module, or to root.
  const moveSectionsToModule = async (target: string) => {
    const ids = [...selSections];
    if (ids.length === 0 || activeLibraryId == null || !target) return;
    const moduleId = target === 'root' ? null : Number(target);
    const destName = moduleId == null ? 'the library root' : `"${modules.find((m) => m.id === moduleId)?.name ?? 'module'}"`;
    try {
      const r = await api.sections.moveModule(ids, activeLibraryId, moduleId);
      flash(`Moved ${r.moved} section(s) to ${destName}.`);
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
    if (mode === 'replace' && !confirm(`Replace ALL modules, sections and test cases in "${activeLibrary?.name}" with the backup? This cannot be undone.`)) return;
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
  // labelled with their module so same-named sections stay distinguishable.
  const sectionOptionLabel = (name: string, moduleName: string | null) =>
    moduleName ? `${moduleName} › ${name}` : name;

  // ── Render cases list ────────────────────────────────────────
  const renderCases = (cases: TestCase[], sectionId: number | null, moduleId: number | null) => {
    const addHere = addCase && addCase.sectionId === sectionId && addCase.moduleId === moduleId;
    const bulkHere = bulkAdd && bulkAdd.sectionId === sectionId && bulkAdd.moduleId === moduleId;
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
                  <option value="">Unsectioned (keep module)</option>
                  {allSections.map(({ section, moduleName }) => (
                    <option key={section.id} value={section.id}>{sectionOptionLabel(section.name, moduleName)}</option>
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
        {addHere ? (
          <div className="flex gap-2 flex-1">
            <input
              className="flex-1 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              placeholder="Test case description..."
              value={addCase!.desc}
              onChange={(e) => setAddCase({ ...addCase!, desc: e.target.value })}
              onKeyDown={(e) => onKey(e, createCase, () => setAddCase(null))}
              autoFocus
            />
            <button onClick={createCase} className="text-green-600 text-xs px-2 py-1 hover:bg-green-50 rounded border border-green-300"><Action icon="plus">Add</Action></button>
            <button onClick={() => setAddCase(null)} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
          </div>
        ) : bulkHere ? (
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
                <Action icon="plus" label="Add cases">Add {bulkAdd!.text.split('\n').map((l) => l.trim()).filter(Boolean).length || ''} cases</Action>
              </button>
              <button onClick={() => setBulkAdd(null)} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
            </div>
          </div>
        ) : (
          <>
            <button onClick={() => { setBulkAdd(null); setAddCase({ sectionId, moduleId, desc: '' }); }} className="text-xs text-blue-500 hover:text-blue-700">
              <Action icon="plus" label="Add test case">+ Add test case</Action>
            </button>
            <button onClick={() => { setAddCase(null); setBulkAdd({ sectionId, moduleId, text: '' }); }} className="text-xs text-blue-500 hover:text-blue-700">
              <Action icon="plusPlus" label="Add many">+ Add many</Action>
            </button>
            {sectionId !== null && (
              <button
                onClick={() => { setAddCase(null); setBulkAdd(null); setNewSectionName(''); setAddAfter({ afterId: sectionId, moduleId }); }}
                className="text-xs text-blue-500 hover:text-blue-700"
              >
                <Action icon="plusPlusPlus" label="Add section">+ Add section</Action>
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

  // One section card — reused for module sections and root sections. `bucket`
  // is the ordered list the section lives in (for move up/down); `moduleId` is
  // its container (null = root), threaded into the add affordances.
  const renderSectionCard = (section: Section, bucket: Section[], idx: number, moduleId: number | null) => {
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
                  <div className="flex items-center gap-1 mr-1 pr-1 border-r border-gray-200">
                    <button
                      onClick={() => setSectionColor(section.id, null)}
                      title="No color"
                      className={`w-3.5 h-3.5 rounded-full bg-white border border-gray-300 hover:scale-110 transition-transform transform-gpu ${section.color === null ? 'ring-2 ring-offset-1 ring-blue-400' : ''}`}
                    />
                    {SECTION_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => setSectionColor(section.id, c)}
                        title={c}
                        className={`w-3.5 h-3.5 rounded-full swatch-${c} border border-black/10 hover:scale-110 transition-transform transform-gpu ${section.color === c ? 'ring-2 ring-offset-1 ring-blue-400' : ''}`}
                      />
                    ))}
                  </div>
                  <button onClick={() => moveSectionInBucket(bucket, idx, -1)} disabled={idx === 0} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs" title="Move up">▲</button>
                  <button onClick={() => moveSectionInBucket(bucket, idx, 1)} disabled={idx === bucket.length - 1} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs" title="Move down">▼</button>
                  <button onClick={() => setEditSection({ id: section.id, name: section.name })} className="px-2 py-1 text-blue-500 hover:text-blue-700 text-sm"><Action icon="pencil">Edit</Action></button>
                  <button onClick={() => deleteSection(section.id)} className="px-2 py-1 text-red-400 hover:text-red-600 text-sm"><Action icon="trash">Delete</Action></button>
                </div>
              </>
            )}
          </div>
          <div className="px-4 py-3">
            {renderCases(section.test_cases, section.id, moduleId)}
          </div>
        </div>
        {addAfter?.afterId === section.id && (
          <div className="mt-3">{renderAddSectionForm()}</div>
        )}
      </div>
    );
  };

  // Module-level unsectioned pile (inside a module card). Rendered when it has
  // cases or when an add affordance is aimed at it.
  const renderModuleUnsectioned = (m: Module) => {
    const showing = m.unsectioned.length > 0 || (addCase?.sectionId === null && addCase.moduleId === m.id) || (bulkAdd?.sectionId === null && bulkAdd.moduleId === m.id);
    if (!showing) return null;
    const uAll = m.unsectioned.length > 0 && m.unsectioned.every((c) => selCases.has(c.id));
    const uSome = m.unsectioned.some((c) => selCases.has(c.id));
    return (
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          {m.unsectioned.length > 0 && (
            <TriCheckbox checked={uAll} indeterminate={uSome} onChange={() => toggleAllIn(m.unsectioned)} title="Select all unsectioned cases in module" className="shrink-0" />
          )}
          <span className="flex-1 font-semibold text-gray-400">Unsectioned</span>
          <span className="text-xs text-gray-300">{m.unsectioned.length} cases</span>
        </div>
        <div className="px-4 py-3">{renderCases(m.unsectioned, null, m.id)}</div>
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
  const moduleCount = selModules.size;

  const selected = (() => {
    if (selectedId == null) return null;
    for (const { section, moduleName } of allSections) {
      const tc = section.test_cases.find((c) => c.id === selectedId);
      if (tc) return { tc, sectionName: moduleName ? `${moduleName} › ${section.name}` : section.name };
    }
    const u = allUnsectioned.find((c) => c.id === selectedId);
    return u ? { tc: u, sectionName: 'Unsectioned' } : null;
  })();

  const canDeleteLibrary = libraries.length > 1;
  const isEmpty = modules.length === 0 && sections.length === 0 && unsectioned.length === 0;

  // Section options for the bulk "Move to…" picker, grouped by module.
  const moveTargetOptions = (
    <>
      {modules.map((m) => (
        <optgroup key={`m${m.id}`} label={m.name}>
          <option value={`u:${m.id}`}>{m.name} · Unsectioned</option>
          {m.sections.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}
        </optgroup>
      ))}
      <optgroup label="Library root">
        <option value="u:root">Unsectioned</option>
        {sections.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}
      </optgroup>
    </>
  );
  const mergeTargetOptions = allSections.map(({ section, moduleName }) => (
    <option key={section.id} value={section.id}>{sectionOptionLabel(section.name, moduleName)}</option>
  ));

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
      {(caseCount > 0 || sectionCount > 0 || moduleCount > 0) && (
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
                onChange={(e) => { if (e.target.value) moveSectionsToModule(e.target.value); }}
                className="border rounded px-2 py-1 text-sm text-gray-600 max-w-[12rem] truncate focus:outline-none focus:ring-1 focus:ring-blue-400"
                title="Move the selected sections into a module (or the library root)"
              >
                <option value="" disabled hidden>Move to module…</option>
                {modules.map((m) => <option key={m.id} value={String(m.id)}>{m.name}</option>)}
                <option value="root">Library root (no module)</option>
              </select>
              <button onClick={bulkDeleteSections} className="px-2 py-1 rounded text-red-600 hover:bg-red-50 border border-red-200 text-xs"><Action icon="trash">Delete</Action></button>
            </div>
          )}
          {moduleCount > 0 && (
            <div className="flex items-center flex-wrap gap-2 text-sm">
              <span className="font-semibold text-gray-700">{moduleCount} module{moduleCount > 1 ? 's' : ''} selected</span>
              <span className="text-xs text-gray-400">their sections + cases are included in a copy</span>
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
                title="Copy the selected modules, sections and cases into another library"
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
              Be careful, you're about to delete an entire library! All modules, sections and cases will disappear!
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
          {addAfter && addAfter.afterId === null && addAfter.moduleId === null ? (
            renderAddSectionForm()
          ) : (
            <>
              <div className="text-3xl mb-2">📋</div>
              <h2 className="text-base font-semibold text-gray-800 mb-1">This library is empty</h2>
              <p className="text-sm text-gray-500 mb-4">
                Start from scratch, or load a small demo set into a new library to see how modules, sections and cases work together.
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
                <button onClick={() => setNewModuleName('')} className="px-3 py-1.5 text-sm border border-gray-300 hover:bg-gray-50 rounded text-gray-700">
                  <Action icon="plus" label="Add module">+ Add module</Action>
                </button>
                <button onClick={() => { setNewSectionName(''); setAddAfter({ afterId: null, moduleId: null }); }} className="px-3 py-1.5 text-sm border border-gray-300 hover:bg-gray-50 rounded text-gray-700">
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
          const secIds = m.sections.map((s) => s.id);
          const caseIds = [...m.sections.flatMap((s) => s.test_cases.map((c) => c.id)), ...m.unsectioned.map((c) => c.id)];
          const modSelected = selModules.has(m.id);
          const allChildren = secIds.every((id) => selSections.has(id)) && caseIds.every((id) => selCases.has(id));
          const fully = modSelected && allChildren;
          const partial = !fully && (modSelected || secIds.some((id) => selSections.has(id)) || caseIds.some((id) => selCases.has(id)));
          return (
            <div key={m.id} className={`module-shell overflow-hidden ${modSelected ? 'ring-1 ring-blue-400' : ''}`}>
              <div className="module-header group/mod flex items-center gap-2 px-4 py-2.5">
                {renameModule?.id === m.id ? (
                  <>
                    <input
                      className="flex-1 font-bold border rounded px-2 py-1 text-sm focus:outline-none"
                      value={renameModule.name}
                      onChange={(e) => setRenameModule({ ...renameModule, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveModuleName(); if (e.key === 'Escape') setRenameModule(null); }}
                      autoFocus
                    />
                    <button onClick={saveModuleName} className="text-xs px-2 py-1 rounded bg-white/15 hover:bg-white/25"><Action icon="save">Save</Action></button>
                    <button onClick={() => setRenameModule(null)} className="text-xs px-2 py-1 rounded hover:bg-white/10"><Action icon="x">Cancel</Action></button>
                  </>
                ) : (
                  <>
                    <TriCheckbox checked={fully} indeterminate={partial} onChange={() => toggleModule(m)} title="Select module and all its contents" className="shrink-0" />
                    <span className="font-bold tracking-wide text-sm">{m.name}</span>
                    <span className="text-xs text-slate-400 ml-1">{m.sections.length} section{m.sections.length === 1 ? '' : 's'}</span>
                    <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/mod:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button onClick={() => moveModule(mIdx, -1)} disabled={mIdx === 0} className="p-1 text-slate-300 hover:text-white disabled:opacity-20 text-xs" title="Move up">▲</button>
                      <button onClick={() => moveModule(mIdx, 1)} disabled={mIdx === modules.length - 1} className="p-1 text-slate-300 hover:text-white disabled:opacity-20 text-xs" title="Move down">▼</button>
                      <button onClick={() => setRenameModule({ id: m.id, name: m.name })} className="px-2 py-1 text-xs text-slate-200 hover:text-white"><Action icon="pencil">Rename</Action></button>
                      <button onClick={() => deleteModule(m.id)} className="px-2 py-1 text-xs text-red-300 hover:text-red-200"><Action icon="trash">Delete</Action></button>
                    </div>
                  </>
                )}
              </div>
              <div className="p-3 space-y-3">
                {m.sections.map((s, i) => renderSectionCard(s, m.sections, i, m.id))}
                {renderModuleUnsectioned(m)}
                <div className="flex items-center gap-3">
                  {addAfter && addAfter.afterId === null && addAfter.moduleId === m.id ? (
                    <div className="flex-1">{renderAddSectionForm()}</div>
                  ) : (
                    <>
                      <button onClick={() => { setNewSectionName(''); setAddAfter({ afterId: null, moduleId: m.id }); }} className="text-xs text-blue-500 hover:text-blue-700">
                        <Action icon="plusPlusPlus" label="Add section">+ Add section</Action>
                      </button>
                      {m.unsectioned.length === 0 && (
                        <button onClick={() => { setBulkAdd(null); setAddCase({ sectionId: null, moduleId: m.id, desc: '' }); }} className="text-xs text-gray-400 hover:text-gray-600">
                          <Action icon="plus" label="Add unsectioned case">+ Add unsectioned case</Action>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* + New module */}
        {newModuleName !== null ? (
          <div className="module-shell overflow-hidden">
            <div className="module-header flex items-center gap-2 px-4 py-2.5">
              <input
                className="flex-1 font-bold border rounded px-2 py-1 text-sm focus:outline-none"
                placeholder="New module name"
                value={newModuleName}
                onChange={(e) => setNewModuleName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createModule(); if (e.key === 'Escape') setNewModuleName(null); }}
                autoFocus
              />
              <button onClick={createModule} className="text-xs px-2 py-1 rounded bg-white/15 hover:bg-white/25"><Action icon="plus">Add</Action></button>
              <button onClick={() => setNewModuleName(null)} className="text-xs px-2 py-1 rounded hover:bg-white/10"><Action icon="x">Cancel</Action></button>
            </div>
          </div>
        ) : (
          !isEmpty && (
            <button onClick={() => setNewModuleName('')} className="text-xs text-blue-500 hover:text-blue-700">
              <Action icon="plus" label="New module">+ New module</Action>
            </button>
          )
        )}

        {/* Root sections */}
        {!isEmpty && sections.length === 0 && unsectioned.length > 0 && (
          <div>
            {addAfter && addAfter.afterId === null && addAfter.moduleId === null ? (
              renderAddSectionForm()
            ) : (
              <button onClick={() => { setNewSectionName(''); setAddAfter({ afterId: null, moduleId: null }); }} className="text-xs text-blue-500 hover:text-blue-700">
                <Action icon="plusPlusPlus" label="Add section">+ Add section</Action>
              </button>
            )}
          </div>
        )}

        {sections.map((s, i) => renderSectionCard(s, sections, i, null))}

        {/* Root unsectioned */}
        {(unsectioned.length > 0 || (addCase?.sectionId === null && addCase.moduleId === null) || (bulkAdd?.sectionId === null && bulkAdd.moduleId === null)) && (() => {
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
              <div className="px-4 py-3">{renderCases(unsectioned, null, null)}</div>
            </div>
          );
        })()}

        {!isEmpty && unsectioned.length === 0 && !(addCase?.sectionId === null && addCase.moduleId === null) && !(bulkAdd?.sectionId === null && bulkAdd.moduleId === null) && (
          <div className="flex items-center gap-3">
            <button onClick={() => { setBulkAdd(null); setAddCase({ sectionId: null, moduleId: null, desc: '' }); }} className="text-xs text-gray-400 hover:text-gray-600">
              <Action icon="plus" label="Add unsectioned test case">+ Add unsectioned test case</Action>
            </button>
            <button onClick={() => { setAddCase(null); setBulkAdd({ sectionId: null, moduleId: null, text: '' }); }} className="text-xs text-gray-400 hover:text-gray-600">
              <Action icon="plusPlus" label="Add many">+ Add many</Action>
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
