import { useEffect, useRef, useState, KeyboardEvent } from 'react';
import { api, backupExportUrl, testCasesPdfUrl } from '../api';
import MarkdownView from '../components/MarkdownView';
import LibraryPicker from '../library/LibraryPicker';
import Action from '../iconmode/Action';
import { useAuth } from '../auth/AuthContext';
import { useLibrary } from '../library/LibraryContext';
import type { Section, SectionColor, TestCase } from '../types';

const SECTION_COLORS: readonly SectionColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

type AddCaseState = { sectionId: number | null; desc: string } | null;
type BulkAddState = { sectionId: number | null; text: string } | null;
type EditCaseState = { id: number; desc: string; notes: string; sectionId: number | null } | null;
type EditSectionState = { id: number; name: string } | null;

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
  const [sections, setSections] = useState<Section[]>([]);
  const [unsectioned, setUnsectioned] = useState<TestCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [editSection, setEditSection] = useState<EditSectionState>(null);
  const [addAfter, setAddAfter] = useState<{ afterId: number | null } | null>(null);
  const [newSectionName, setNewSectionName] = useState('');

  const [editCase, setEditCase] = useState<EditCaseState>(null);
  const [addCase, setAddCase] = useState<AddCaseState>(null);
  const [bulkAdd, setBulkAdd] = useState<BulkAddState>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const notesTextareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const [selCases, setSelCases] = useState<Set<number>>(new Set());
  const [selSections, setSelSections] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const backupInputRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  // Library-management UI state — inline in the header, not modals.
  //   newLibName === null    → "+ New library" not clicked
  //   renameLibName === null → not renaming
  const [newLibName, setNewLibName] = useState<string | null>(null);
  const [renameLibName, setRenameLibName] = useState<string | null>(null);
  // Deletion is destructive enough that we want more than a window.confirm.
  // The modal asks for a typed "REALLY" acknowledgement before firing.
  const [deleteLibOpen, setDeleteLibOpen] = useState(false);
  const [deleteLibTyped, setDeleteLibTyped] = useState('');
  const [deleteLibBusy, setDeleteLibBusy] = useState(false);
  const [deleteLibError, setDeleteLibError] = useState('');

  const fetchData = async (libId: number) => {
    try {
      const { sections: s, unsectioned: u } = await api.sections.list(libId);
      setSections(s);
      setUnsectioned(u);
      // Drop any selected ids that no longer exist.
      const caseIds = new Set<number>([...s.flatMap((x) => x.test_cases.map((c) => c.id)), ...u.map((c) => c.id)]);
      const secIds = new Set<number>(s.map((x) => x.id));
      setSelCases((prev) => new Set([...prev].filter((id) => caseIds.has(id))));
      setSelSections((prev) => new Set([...prev].filter((id) => secIds.has(id))));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Refetch whenever the active library changes. Also clears per-library UI
  // state (edit dialogs, selection, preview) since those don't carry over.
  useEffect(() => {
    if (activeLibraryId == null) { setLoading(false); return; }
    setLoading(true);
    setEditCase(null); setAddCase(null); setBulkAdd(null);
    setEditSection(null); setAddAfter(null); setNewSectionName('');
    setSelCases(new Set()); setSelSections(new Set()); setSelectedId(null);
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

  const openDeleteLibrary = () => {
    setDeleteLibOpen(true);
    setDeleteLibTyped('');
    setDeleteLibError('');
  };
  const closeDeleteLibrary = () => {
    if (deleteLibBusy) return;
    setDeleteLibOpen(false);
    setDeleteLibTyped('');
    setDeleteLibError('');
  };
  const confirmDeleteLibrary = async () => {
    if (!activeLibrary) return;
    if (deleteLibTyped !== 'REALLY') return;
    setDeleteLibBusy(true);
    setDeleteLibError('');
    try {
      await api.libraries.delete(activeLibrary.id);
      // refreshLibraries will pick a new active library (first row).
      await refreshLibraries();
      setDeleteLibOpen(false);
      setDeleteLibTyped('');
      flash('Library deleted.');
    } catch (e: any) {
      setDeleteLibError(e.message);
    } finally {
      setDeleteLibBusy(false);
    }
  };

  // ── Section actions ──────────────────────────────────────────
  const createSection = async () => {
    if (!newSectionName.trim() || !addAfter || activeLibraryId == null) return;
    const opts = addAfter.afterId != null ? { after_id: addAfter.afterId } : undefined;
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
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, color } : s)));
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
    setSelSections((prev) => {
      const n = new Set(prev);
      if (fullyChecked) n.delete(section.id); else n.add(section.id);
      return n;
    });
    setSelCases((prev) => {
      const n = new Set(prev);
      if (fullyChecked) caseIds.forEach((id) => n.delete(id));
      else caseIds.forEach((id) => n.add(id));
      return n;
    });
  };

  const deleteSection = async (id: number) => {
    if (!confirm('Delete this section? Its test cases will become unsectioned.')) return;
    if (activeLibraryId == null) return;
    await api.sections.delete(id);
    fetchData(activeLibraryId);
  };

  const moveSectionUp = async (idx: number) => {
    if (idx === 0 || activeLibraryId == null) return;
    const next = [...sections];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    setSections(next);
    await api.sections.reorder(next.map((s) => s.id), activeLibraryId);
  };

  const moveSectionDown = async (idx: number) => {
    if (idx === sections.length - 1 || activeLibraryId == null) return;
    const next = [...sections];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    setSections(next);
    await api.sections.reorder(next.map((s) => s.id), activeLibraryId);
  };

  // ── Test case actions ────────────────────────────────────────
  const createCase = async () => {
    if (!addCase?.desc.trim() || activeLibraryId == null) return;
    await api.testCases.create({ section_id: addCase.sectionId, description: addCase.desc.trim(), library_id: activeLibraryId });
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

  const moveCaseUp = async (cases: TestCase[], sectionId: number | null, idx: number) => {
    if (idx === 0 || activeLibraryId == null) return;
    const next = [...cases];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    if (sectionId === null) setUnsectioned(next);
    else setSections(sections.map((s) => (s.id === sectionId ? { ...s, test_cases: next } : s)));
    await api.testCases.reorder(next.map((c) => c.id), activeLibraryId);
  };

  const moveCaseDown = async (cases: TestCase[], sectionId: number | null, idx: number) => {
    if (idx === cases.length - 1 || activeLibraryId == null) return;
    const next = [...cases];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    if (sectionId === null) setUnsectioned(next);
    else setSections(sections.map((s) => (s.id === sectionId ? { ...s, test_cases: next } : s)));
    await api.testCases.reorder(next.map((c) => c.id), activeLibraryId);
  };

  // ── Bulk add (paste a list, one case per line) ───────────────
  const runBulkAdd = async () => {
    if (!bulkAdd || activeLibraryId == null) return;
    const descriptions = bulkAdd.text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (descriptions.length === 0) { setBulkAdd(null); return; }
    try {
      const r = await api.testCases.bulkCreate(bulkAdd.sectionId, descriptions, activeLibraryId);
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
  const clearSel = () => { setSelCases(new Set()); setSelSections(new Set()); };

  // ── Bulk case operations ─────────────────────────────────────
  const bulkMoveCases = async (targetSectionId: number | null) => {
    const ids = [...selCases];
    if (ids.length === 0 || activeLibraryId == null) return;
    try {
      const r = await api.testCases.bulkMove(ids, targetSectionId, activeLibraryId);
      const dest = targetSectionId === null ? 'Unsectioned' : sections.find((s) => s.id === targetSectionId)?.name ?? 'section';
      flash(`Moved ${r.moved} test case(s) to ${dest}.`);
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

  // ── Bulk section operations ──────────────────────────────────
  const mergeSections = async (targetId: number) => {
    const sources = [...selSections].filter((id) => id !== targetId);
    if (sources.length === 0 || activeLibraryId == null) { setError('Pick a different target section to merge into.'); return; }
    const targetName = sections.find((s) => s.id === targetId)?.name ?? 'section';
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
    if (!confirm(`Delete ${ids.length} section(s)? Their test cases will become unsectioned.`)) return;
    try {
      const r = await api.sections.bulkDelete(ids);
      flash(`Deleted ${r.deleted} section(s).`);
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
    setError('');
    setMessage('');
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError('Please choose a .zip exotick backup file.');
      return;
    }
    setImportFile(file);
  };

  const runImport = async (mode: 'new' | 'merge' | 'replace') => {
    if (!importFile) return;
    if (mode === 'replace' && !confirm(`Replace ALL sections and test cases in "${activeLibrary?.name}" with the backup? This cannot be undone.`)) return;
    setImportBusy(true);
    setError('');
    try {
      const r = await api.backup.import({
        file: importFile,
        mode,
        target_library_id: mode === 'new' ? undefined : activeLibraryId ?? undefined,
      });
      // 'new' mode created a fresh library — switch to it so the user sees
      // the result immediately.
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

  const sectionTargetOptions = sections.map((s) => (
    <option key={s.id} value={s.id}>{s.name}</option>
  ));

  // ── Render cases list ────────────────────────────────────────
  const renderCases = (cases: TestCase[], sectionId: number | null) => {
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
                  className="border rounded px-2 py-1 text-sm max-w-[12rem] truncate focus:outline-none focus:ring-1 focus:ring-blue-400"
                  value={editCase.sectionId ?? ''}
                  onChange={(e) => setEditCase({ ...editCase, sectionId: e.target.value === '' ? null : Number(e.target.value) })}
                >
                  <option value="">Unsectioned</option>
                  {sectionTargetOptions}
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
                <span>{tc.description}</span>
                {tc.notes && <span className="shrink-0 text-gray-300 mt-0.5" title="Has a description">📄</span>}
              </button>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => moveCaseUp(cases, sectionId, i)}
                  disabled={i === 0}
                  className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs"
                  title="Move up"
                >▲</button>
                <button
                  onClick={() => moveCaseDown(cases, sectionId, i)}
                  disabled={i === cases.length - 1}
                  className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs"
                  title="Move down"
                >▼</button>
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
        {addCase?.sectionId === sectionId ? (
          <div className="flex gap-2 flex-1">
            <input
              className="flex-1 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              placeholder="Test case description..."
              value={addCase.desc}
              onChange={(e) => setAddCase({ ...addCase, desc: e.target.value })}
              onKeyDown={(e) => onKey(e, createCase, () => setAddCase(null))}
              autoFocus
            />
            <button onClick={createCase} className="text-green-600 text-xs px-2 py-1 hover:bg-green-50 rounded border border-green-300"><Action icon="plus">Add</Action></button>
            <button onClick={() => setAddCase(null)} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
          </div>
        ) : bulkAdd?.sectionId === sectionId ? (
          <div className="flex flex-col gap-1.5 flex-1">
            <span className="text-xs text-gray-400">One test case per line</span>
            <textarea
              className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
              rows={5}
              placeholder={"Valid login works\nInvalid password shows error\nLocked account is blocked"}
              value={bulkAdd.text}
              onChange={(e) => setBulkAdd({ ...bulkAdd, text: e.target.value })}
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={runBulkAdd} className="text-green-600 text-xs px-2 py-1 hover:bg-green-50 rounded border border-green-300">
                <Action icon="plus" label="Add cases">Add {bulkAdd.text.split('\n').map((l) => l.trim()).filter(Boolean).length || ''} cases</Action>
              </button>
              <button onClick={() => setBulkAdd(null)} className="text-gray-400 text-xs px-2 py-1 hover:bg-gray-100 rounded"><Action icon="x">Cancel</Action></button>
            </div>
          </div>
        ) : (
          <>
            <button onClick={() => { setBulkAdd(null); setAddCase({ sectionId, desc: '' }); }} className="text-xs text-blue-500 hover:text-blue-700">
              <Action icon="plus" label="Add test case">+ Add test case</Action>
            </button>
            <button onClick={() => { setAddCase(null); setBulkAdd({ sectionId, text: '' }); }} className="text-xs text-blue-500 hover:text-blue-700">
              <Action icon="plusPlus" label="Add many">+ Add many</Action>
            </button>
            {sectionId !== null && (
              <button
                onClick={() => { setAddCase(null); setBulkAdd(null); setNewSectionName(''); setAddAfter({ afterId: sectionId }); }}
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

  // ── Render ───────────────────────────────────────────────────
  if (librariesLoading) return <div className="text-gray-400 text-sm">Loading libraries…</div>;
  if (libraries.length === 0 || activeLibraryId == null) {
    // Shouldn't happen (server guarantees at least one library) but be
    // defensive so we don't render broken selects.
    return <div className="text-gray-500 text-sm">No libraries found.</div>;
  }
  if (loading) return <div className="text-gray-400 text-sm">Loading library…</div>;

  const caseCount = selCases.size;
  const sectionCount = selSections.size;

  const selected = (() => {
    if (selectedId == null) return null;
    for (const s of sections) {
      const tc = s.test_cases.find((c) => c.id === selectedId);
      if (tc) return { tc, sectionName: s.name };
    }
    const u = unsectioned.find((c) => c.id === selectedId);
    return u ? { tc: u, sectionName: 'Unsectioned' } : null;
  })();

  const canDeleteLibrary = libraries.length > 1;

  return (
    <>
      {/* Library toolbar — sits above the page title. Switch libraries,
          rename/delete the active one, or create a new one. */}
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
            <button
              onClick={() => setRenameLibName(activeLibrary.name)}
              className="text-xs px-2 py-1 border rounded text-gray-600 hover:bg-gray-50"
              title="Rename this library"
            >
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
          <button
            onClick={() => setNewLibName('')}
            className="text-xs px-2 py-1 text-blue-600 hover:text-blue-800"
          >
            <Action icon="plus" label="New library">+ New library</Action>
          </button>
        )}
      </div>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Edit Mode</h1>
        <div className="flex items-center gap-2">
          {canBackup && (
            <>
              <a
                href={backupExportUrl(activeLibraryId)}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
                title="Download a backup .zip of this library"
              >
                <Action icon="download">Export Backup</Action>
              </a>
              <button
                onClick={() => backupInputRef.current?.click()}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
                title="Restore or import a backup .zip file"
              >
                <Action icon="upload">Import Backup</Action>
              </button>
              <input
                ref={backupInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={handleBackupFile}
              />
            </>
          )}
          <a
            href={testCasesPdfUrl(activeLibraryId)}
            target="_blank"
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
          >
            <Action icon="download">Export PDF</Action>
          </a>
        </div>
      </div>

    <div className="flex gap-6">
      <div className="w-3/5 min-w-0">

      {/* Bulk action bar — sticky, shown when anything is selected */}
      {(caseCount > 0 || sectionCount > 0) && (
        <div className="sticky top-0 z-30 -mx-1 mb-4 bg-white border rounded-lg shadow-sm px-3 py-2 flex flex-col gap-2">
          {caseCount > 0 && (
            <div className="flex items-center flex-wrap gap-2 text-sm">
              <span className="font-semibold text-gray-700">{caseCount} case{caseCount > 1 ? 's' : ''} selected</span>
              <select
                value=""
                onChange={(e) => { const v = e.target.value; if (v !== '') bulkMoveCases(v === 'null' ? null : Number(v)); }}
                className="border rounded px-2 py-1 text-sm text-gray-600 max-w-[11rem] truncate focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                <option value="">Move to…</option>
                <option value="null">Unsectioned</option>
                {sectionTargetOptions}
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
                onChange={(e) => { const v = e.target.value; if (v !== '') mergeSections(Number(v)); }}
                className="border rounded px-2 py-1 text-sm text-gray-600 max-w-[11rem] truncate focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                <option value="">Merge into…</option>
                {sectionTargetOptions}
              </select>
              <button onClick={bulkDeleteSections} className="px-2 py-1 rounded text-red-600 hover:bg-red-50 border border-red-200 text-xs"><Action icon="trash">Delete</Action></button>
            </div>
          )}
          <button onClick={clearSel} className="self-start text-xs text-gray-400 hover:text-gray-600"><Action icon="deselect">Clear selection</Action></button>
        </div>
      )}

      {error && <div className="text-red-600 text-sm mb-4">{error}</div>}
      {message && <div className="text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 text-sm mb-4">{message}</div>}

      {/* Delete-library confirmation. Types-in "REALLY" gate — high friction
          because cascading a library wipes every section + case inside. */}
      {deleteLibOpen && activeLibrary && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={closeDeleteLibrary}>
          <form
            onSubmit={(e) => { e.preventDefault(); confirmDeleteLibrary(); }}
            className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-2xl mb-1">⚠️</div>
            <h2 className="text-lg font-bold text-gray-800 mb-2">Delete library "{activeLibrary.name}"?</h2>
            <p className="text-sm text-gray-700 mb-3">
              Be careful, you're about to delete an entire library! All sections and cases will disappear!
              Are you <span className="font-bold">REALLY</span> sure?
            </p>
            <p className="text-xs text-gray-500 mb-2">
              Type <span className="font-mono font-bold text-gray-700">REALLY</span> below to confirm.
            </p>
            <input
              autoFocus
              type="text"
              value={deleteLibTyped}
              onChange={(e) => { setDeleteLibTyped(e.target.value); setDeleteLibError(''); }}
              // "REALLY" must be typed by hand — pasting / drag-drop is blocked
              // so the acknowledgement can't be shortcut with a clipboard copy.
              onPaste={(e) => { e.preventDefault(); setDeleteLibError('Type it out — pasting is disabled.'); }}
              onDrop={(e) => e.preventDefault()}
              onDragOver={(e) => e.preventDefault()}
              autoComplete="off"
              placeholder="Type REALLY"
              className="w-full border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-red-400"
            />
            {deleteLibError && <div className="text-red-600 text-sm mt-2">{deleteLibError}</div>}
            <div className="flex gap-2 mt-4">
              <button
                type="submit"
                disabled={deleteLibBusy || deleteLibTyped !== 'REALLY'}
                className="flex-1 px-3 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Action icon="trash" label="Delete library">{deleteLibBusy ? 'Deleting…' : 'Delete library'}</Action>
              </button>
              <button
                type="button"
                onClick={closeDeleteLibrary}
                disabled={deleteLibBusy}
                className="px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded disabled:opacity-50"
              >
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
              <button
                onClick={() => runImport('new')}
                disabled={importBusy}
                className="w-full px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 text-left"
              >
                <span className="font-semibold">Create new library</span> — leaves existing libraries untouched
              </button>
              <button
                onClick={() => runImport('merge')}
                disabled={importBusy}
                className="w-full px-3 py-2 text-sm border border-blue-600 text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50 text-left"
              >
                <span className="font-semibold">Merge into "{activeLibrary?.name}"</span> — append to the current library
              </button>
              <button
                onClick={() => runImport('replace')}
                disabled={importBusy}
                className="w-full px-3 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50 text-left"
              >
                <span className="font-semibold">Replace "{activeLibrary?.name}"</span> — wipe the current library, then restore
              </button>
              <button
                onClick={() => setImportFile(null)}
                disabled={importBusy}
                className="w-full px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded disabled:opacity-50"
              >
                <Action icon="x">Cancel</Action>
              </button>
            </div>
            {importBusy && <div className="text-xs text-gray-400 mt-3">Importing…</div>}
          </div>
        </div>
      )}

      {/* Empty-state welcome */}
      {sections.length === 0 && unsectioned.length === 0 && (
        <div className="mb-3 bg-white border rounded-lg p-6 text-center">
          {addAfter && addAfter.afterId === null ? (
            renderAddSectionForm()
          ) : (
            <>
              <div className="text-3xl mb-2">📋</div>
              <h2 className="text-base font-semibold text-gray-800 mb-1">This library is empty</h2>
              <p className="text-sm text-gray-500 mb-4">
                Start from scratch, or load a small demo set into a new library to see how sections and cases work together.
              </p>
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={async () => {
                    try {
                      const r = await api.samples.load();
                      await refreshLibraries();
                      setActiveLibrary(r.library.id);
                      flash(`Created "${r.library.name}" with ${r.casesAdded} sample case(s) across ${r.sectionsAdded} section(s).`);
                    } catch (e: any) {
                      setError(e.message);
                    }
                  }}
                  className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded"
                >
                  <Action icon="sparkles">Load sample data</Action>
                </button>
                <button
                  onClick={() => { setNewSectionName(''); setAddAfter({ afterId: null }); }}
                  className="px-3 py-1.5 text-sm border border-gray-300 hover:bg-gray-50 rounded text-gray-700"
                >
                  <Action icon="plusPlusPlus" label="Add section">+ Add section</Action>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {sections.length === 0 && unsectioned.length > 0 && (
        <div className="mb-3">
          {addAfter && addAfter.afterId === null ? (
            renderAddSectionForm()
          ) : (
            <button
              onClick={() => { setNewSectionName(''); setAddAfter({ afterId: null }); }}
              className="text-xs text-blue-500 hover:text-blue-700"
            >
              <Action icon="plusPlusPlus" label="Add section">+ Add section</Action>
            </button>
          )}
        </div>
      )}

      <div className="space-y-3">
        {sections.map((section, sIdx) => {
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
                    <button
                      onClick={() => moveSectionUp(sIdx)}
                      disabled={sIdx === 0}
                      className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs"
                      title="Move up"
                    >▲</button>
                    <button
                      onClick={() => moveSectionDown(sIdx)}
                      disabled={sIdx === sections.length - 1}
                      className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs"
                      title="Move down"
                    >▼</button>
                    <button
                      onClick={() => setEditSection({ id: section.id, name: section.name })}
                      className="px-2 py-1 text-blue-500 hover:text-blue-700 text-sm"
                    ><Action icon="pencil">Edit</Action></button>
                    <button
                      onClick={() => deleteSection(section.id)}
                      className="px-2 py-1 text-red-400 hover:text-red-600 text-sm"
                    ><Action icon="trash">Delete</Action></button>
                  </div>
                </>
              )}
            </div>
            <div className="px-4 py-3">
              {renderCases(section.test_cases, section.id)}
            </div>
          </div>
          {addAfter?.afterId === section.id && (
            <div className="mt-3">{renderAddSectionForm()}</div>
          )}
          </div>
          );
        })}

        {/* Unsectioned */}
        {(unsectioned.length > 0 || addCase?.sectionId === null || bulkAdd?.sectionId === null) && (() => {
          const uAll = unsectioned.length > 0 && unsectioned.every((c) => selCases.has(c.id));
          const uSome = unsectioned.some((c) => selCases.has(c.id));
          return (
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              {unsectioned.length > 0 && (
                <TriCheckbox
                  checked={uAll}
                  indeterminate={uSome}
                  onChange={() => toggleAllIn(unsectioned)}
                  title="Select all unsectioned cases"
                  className="shrink-0"
                />
              )}
              <span className="flex-1 font-semibold text-gray-400">Unsectioned</span>
              <span className="text-xs text-gray-300">{unsectioned.length} cases</span>
            </div>
            <div className="px-4 py-3">
              {renderCases(unsectioned, null)}
            </div>
          </div>
          );
        })()}

        {unsectioned.length === 0 && addCase?.sectionId !== null && bulkAdd?.sectionId !== null && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setBulkAdd(null); setAddCase({ sectionId: null, desc: '' }); }}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              <Action icon="plus" label="Add unsectioned test case">+ Add unsectioned test case</Action>
            </button>
            <button
              onClick={() => { setAddCase(null); setBulkAdd({ sectionId: null, text: '' }); }}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
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
