import type { TestRunItem } from '../types';

export interface RunSectionGroup {
  sectionName: string;
  items: TestRunItem[];
}
export interface RunModuleBlock {
  // null = library-root content (no module wrapper).
  moduleName: string | null;
  sections: RunSectionGroup[];
}

// Group a run's items into module blocks → section groups, preserving the
// order the items arrive in. Compose orders items module → section → case, so
// every module run and every section run within it is contiguous — a single
// linear pass reconstructs the two-level grouping without sorting.
export function buildModuleBlocks(items: TestRunItem[]): RunModuleBlock[] {
  const blocks: RunModuleBlock[] = [];
  let prevModule: string | null | undefined = undefined;
  let prevSection: string | null | undefined = undefined;
  for (const item of items) {
    const moduleName = item.snapshot_module_name ?? null;
    const sectionName = item.snapshot_section_name ?? 'Unsectioned';
    if (blocks.length === 0 || moduleName !== prevModule) {
      blocks.push({ moduleName, sections: [] });
      prevSection = undefined;
    }
    const block = blocks[blocks.length - 1];
    if (block.sections.length === 0 || sectionName !== prevSection) {
      block.sections.push({ sectionName, items: [] });
    }
    block.sections[block.sections.length - 1].items.push(item);
    prevModule = moduleName;
    prevSection = sectionName;
  }
  return blocks;
}
