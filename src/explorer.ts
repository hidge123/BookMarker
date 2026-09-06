import { descendants, hostname } from './tree';
import type { BookmarkRecord, CheckResult, Expected, OperationRecord } from './types';

export type DisplaySort = 'browser' | 'name' | 'created' | 'type';
export interface LocationState { ancestors?: string[]; folderId?: string; query: string; scrollTop: number; rowOffset?: number; firstVisibleId?: string }
export interface ExplorerState extends LocationState { view: 'grid' | 'list'; sort: DisplaySort; ancestors: string[] }
export interface ClipboardState { kind: 'cut' | 'copy'; nodes: Expected[]; token: string }
export interface DropIntent { parentId: string; beforeId?: string }
export interface DashboardFilter { query: string; folderId: string; domain: string; type: string; status: string; duplicate: string }
export const defaultFilter: DashboardFilter = { query: '', folderId: '', domain: '', type: 'all', status: 'all', duplicate: 'all' };
export const defaultExplorer: ExplorerState = { query: '', scrollTop: 0, view: 'grid', sort: 'browser', ancestors: [] };
export function ancestorIds(id: string | undefined, map: Map<string, BookmarkRecord>): string[] {
  const result: string[] = []; let n = map.get(id ?? '');
  while (n?.parentId) { result.unshift(n.id); n = map.get(n.parentId); }
  return result;
}
export function validFolder(id: string | undefined, ancestors: string[], map: Map<string, BookmarkRecord>): string | undefined {
  return [id, ...ancestors.slice().reverse()].find(key => { const n = map.get(key ?? ''); return n && n.parentId && n.url === undefined && !n.inTrash; });
}
export function sortRows(rows: BookmarkRecord[], sort: DisplaySort): BookmarkRecord[] {
  if (sort === 'browser') return rows;
  return [...rows].sort((a, b) => (sort === 'created' ? (b.dateAdded ?? 0) - (a.dateAdded ?? 0) : sort === 'type' ? Number(a.url !== undefined) - Number(b.url !== undefined) : 0) || a.title.localeCompare(b.title, 'zh-CN'));
}
export function explorerRows(records: BookmarkRecord[], folderId: string | undefined, query: string, sort: DisplaySort): BookmarkRecord[] {
  const q = query.trim().toLowerCase(); const below = folderId && q ? descendants(folderId, records) : undefined;
  const rootIds = new Set(records.filter(n => !n.parentId).map(n => n.id));
  return sortRows(records.filter(n => n.parentId && !n.inTrash && (q ? n.id !== folderId && (!below || below.has(n.id)) && `${n.title}\n${n.url ?? ''}`.toLowerCase().includes(q) : folderId ? n.parentId === folderId : rootIds.has(n.parentId))), sort);
}
export function statusOf(result?: CheckResult): string { return result?.stale ? 'stale' : result?.status ?? 'unchecked'; }
export function dashboardRows(records: BookmarkRecord[], results: Map<string, CheckResult>, f: DashboardFilter): BookmarkRecord[] {
  const below = f.folderId ? descendants(f.folderId, records) : undefined;
  const scoped = records.filter(n => n.parentId && !n.inTrash && n.id !== f.folderId && (!below || below.has(n.id)));
  const counts = new Map<string, number>(); for (const n of scoped) if (n.url !== undefined) counts.set(n.url, (counts.get(n.url) ?? 0) + 1);
  return scoped.filter(n => {
    const s = statusOf(results.get(n.id));
    return (!f.query || `${n.title}\n${n.url ?? ''}`.toLowerCase().includes(f.query.trim().toLowerCase())) &&
      (!f.domain || hostname(n.url).toLowerCase().includes(f.domain.trim().toLowerCase())) &&
      (f.type === 'all' || (f.type === 'folder') === (n.url === undefined)) &&
      (f.status === 'all' || (n.url !== undefined && (f.status === 'issues' ? !['ok', 'unchecked', 'stale', 'skipped'].includes(s) : f.status === 'checked' ? !['unchecked', 'stale'].includes(s) : f.status === s))) &&
      (f.duplicate === 'all' || (n.url !== undefined && (f.duplicate === 'yes' ? (counts.get(n.url) ?? 0) > 1 : counts.get(n.url) === 1)));
  });
}
export function validDrop(intent: DropIntent, ids: string[], map: Map<string, BookmarkRecord>): boolean {
  const target = map.get(intent.parentId); if (!ids.length || !target?.parentId || target.url !== undefined || target.readOnly || target.inTrash) return false;
  if (ids.some(id => { const n = map.get(id); return !n || n.fixed || n.readOnly || n.inTrash; })) return false;
  let p: BookmarkRecord | undefined = target; const moving = new Set(ids);
  while (p) { if (moving.has(p.id)) return false; p = map.get(p.parentId ?? ''); }
  return !intent.beforeId || (map.get(intent.beforeId)?.parentId === target.id && !moving.has(intent.beforeId));
}
export function completedIds(op: OperationRecord): string[] {
  return op.steps.filter(s => s.state === 'done' && !s.systemRecycle && (s.kind !== 'create' || !s.parentRef)).map(s => s.createdId ?? s.nodeId!).filter(Boolean);
}
export function finishCut(clipboard: ClipboardState | undefined, op: OperationRecord, token: string): ClipboardState | undefined {
  if (!clipboard || clipboard.kind !== 'cut' || clipboard.token !== token) return clipboard;
  const done = new Set(op.steps.filter(s => s.kind === 'move' && s.state === 'done').map(s => s.nodeId));
  const nodes = clipboard.nodes.filter(n => !done.has(n.id)).map(n => op.steps.find(s => s.kind === 'move' && s.nodeId === n.id)?.expected ?? n); return nodes.length ? { ...clipboard, nodes } : undefined;
}
export interface Layout { columns: number; cellWidth: number; rowHeight: number; inset: number; grid: boolean }
export function layoutFor(width: number, grid: boolean): Layout {
  const inset = grid ? 16 : 0; const columns = grid ? Math.max(1, Math.floor((width - 2 * inset) / 132)) : 1;
  return { columns, cellWidth: Math.max(1, (width - 2 * inset) / columns), rowHeight: grid ? 124 : 42, inset, grid };
}
export function itemRect(index: number, layout: Layout) {
  const { columns, cellWidth, rowHeight, inset, grid } = layout;
  return { x: inset + index % columns * cellWidth + (grid ? 8 : 0), y: inset + Math.floor(index / columns) * rowHeight + (grid ? 6 : 0), width: cellWidth - (grid ? 16 : 0), height: rowHeight - (grid ? 12 : 0) };
}
export function marqueeIds(rows: BookmarkRecord[], layout: Layout, rect: { x: number; y: number; width: number; height: number }): string[] {
  const first = Math.max(0, Math.floor((rect.y - layout.inset) / layout.rowHeight) * layout.columns);
  const last = Math.min(rows.length, (Math.floor((rect.y + rect.height - layout.inset) / layout.rowHeight) + 1) * layout.columns);
  const ids: string[] = [];
  for (let i = first; i < last; i++) { const r = itemRect(i, layout); if (r.x < rect.x + rect.width && r.x + r.width > rect.x && r.y < rect.y + rect.height && r.y + r.height > rect.y) ids.push(rows[i].id); }
  return ids;
}
