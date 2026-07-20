import type { TestRunItem } from '../types';

export interface RunSectionGroup {
  sectionName: string;
  items: TestRunItem[];
}
export interface RunSubModuleBlock {
  // null = content not in a sub-module.
  subModuleName: string | null;
  sections: RunSectionGroup[];
}
export interface RunModuleBlock {
  // null = library-root content (no module wrapper).
  moduleName: string | null;
  subModules: RunSubModuleBlock[];
}

// Group a run's items into module blocks → sub-module blocks → section groups,
// preserving the order the items arrive in. Compose orders items module →
// sub-module → section → case, so every run of each level is contiguous — a
// single linear pass reconstructs the three-level grouping without sorting.
export function buildModuleBlocks(items: TestRunItem[]): RunModuleBlock[] {
  const blocks: RunModuleBlock[] = [];
  let prevModule: string | null | undefined = undefined;
  let prevSubModule: string | null | undefined = undefined;
  let prevSection: string | null | undefined = undefined;
  for (const item of items) {
    const moduleName = item.snapshot_module_name ?? null;
    const subModuleName = item.snapshot_sub_module_name ?? null;
    const sectionName = item.snapshot_section_name ?? 'Unsectioned';
    if (blocks.length === 0 || moduleName !== prevModule) {
      blocks.push({ moduleName, subModules: [] });
      prevSubModule = undefined;
      prevSection = undefined;
    }
    const block = blocks[blocks.length - 1];
    if (block.subModules.length === 0 || subModuleName !== prevSubModule) {
      block.subModules.push({ subModuleName, sections: [] });
      prevSection = undefined;
    }
    const sub = block.subModules[block.subModules.length - 1];
    if (sub.sections.length === 0 || sectionName !== prevSection) {
      sub.sections.push({ sectionName, items: [] });
    }
    sub.sections[sub.sections.length - 1].items.push(item);
    prevModule = moduleName;
    prevSubModule = subModuleName;
    prevSection = sectionName;
  }
  return blocks;
}
