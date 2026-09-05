import type { BookmarkRecord, BrowserNode, Expected, NodeMetadata } from './types';

export function flatten(tree: BrowserNode[], metadata: NodeMetadata[] = []): BookmarkRecord[] {
  const meta = new Map(metadata.map(m => [m.id, m]));
  const output: BookmarkRecord[] = [];
  function visit(node: BrowserNode, ancestors: BrowserNode[], managed: boolean, trash: boolean) {
    const fixed = !node.parentId || !!node.folderType || ancestors.length === 1;
    const readOnly = managed || !!node.unmodifiable || node.folderType === 'managed';
    const inTrash = trash || !!meta.get(node.id)?.recycleRegion;
    output.push({ ...node, index: node.index ?? 0, children: node.children?.map(c => c.id) ?? [], fixed, readOnly,
      regionId: ancestors[1]?.id ?? (ancestors.length === 1 ? node.id : ''),
      path: ancestors.filter(n => n.parentId).map(n => n.title), inTrash,
      metadataRef: meta.has(node.id) ? node.id : undefined });
    for (const child of node.children ?? []) visit(child, [...ancestors, node], readOnly, inTrash);
  }
  for (const root of tree) visit(root, [], false, false);
  return output;
}
export function expected(node: BookmarkRecord | BrowserNode): Expected {
  return { id: node.id, title: node.title, url: node.url, parentId: node.parentId, index: node.index ?? 0 };
}
export function matches(actual: Expected | undefined, target: Expected | undefined, ignoreIndex = false): boolean {
  return !!actual && !!target && actual.id === target.id && actual.title === target.title && actual.url === target.url && actual.parentId === target.parentId && (ignoreIndex || actual.index === target.index);
}
export function minimalSelection(nodes: Expected[], records: BookmarkRecord[]): Expected[] {
  const ids = new Set(nodes.map(n => n.id));
  const map = new Map(records.map(n => [n.id, n]));
  return nodes.filter(n => { let p = n.parentId; while (p) { if (ids.has(p)) return false; p = map.get(p)?.parentId; } return true; });
}
export function descendants(id: string, records: BookmarkRecord[]): Set<string> {
  const map = new Map(records.map(n => [n.id, n])); const ids = new Set<string>(); const queue = [id];
  while (queue.length) { const n = map.get(queue.pop()!); if (!n || ids.has(n.id)) continue; ids.add(n.id); queue.push(...n.children); }
  return ids;
}
export function duplicates(records: BookmarkRecord[]): Map<string, BookmarkRecord[]> {
  const groups = new Map<string, BookmarkRecord[]>();
  for (const n of records) if (n.url !== undefined && !n.inTrash) { const group = groups.get(n.url); if (group) group.push(n); else groups.set(n.url, [n]); }
  return new Map([...groups].filter(([, nodes]) => nodes.length > 1));
}
export function hostname(url?: string): string { try { return new URL(url!).hostname; } catch { return ''; } }
export function treeDigest(tree: BrowserNode): string {
  return JSON.stringify([tree.id, tree.title, tree.url, tree.parentId, tree.children?.map(treeDigest)]);
}
export interface RenameRule { find: string; replace: string; prefix: string; suffix: string; numbering: boolean; start: number }
export function renamePreview(nodes: BookmarkRecord[], rule: RenameRule): { expected: Expected; title: string }[] {
  return nodes.map((n, i) => ({ expected: expected(n), title: `${rule.prefix}${rule.numbering ? `${rule.start + i} ` : ''}${rule.find ? n.title.split(rule.find).join(rule.replace) : n.title}${rule.suffix}` }));
}
