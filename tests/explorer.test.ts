import { describe, expect, it } from 'vitest';
import { ancestorIds, completedIds, dashboardRows, defaultFilter, explorerRows, finishCut, itemRect, layoutFor, marqueeIds, validDrop, validFolder } from '../src/explorer';
import { flatten, expected } from '../src/tree';
import { MockBookmarks } from './mock-browser';
import type { BookmarkRecord, CheckResult, OperationRecord } from '../src/types';
async function fixture() {
  const api = new MockBookmarks(); const f = await api.create({ parentId: 'bar-local', title: '目录' }); const sub = await api.create({ parentId: f.id, title: 'sub' });
  const a = await api.create({ parentId: f.id, title: 'Zed', url: 'https://example.com/X' }); const b = await api.create({ parentId: sub.id, title: 'Alpha', url: 'https://example.com/X' });
  const c = await api.create({ parentId: 'bar-account', title: '外部', url: 'https://example.com/X' });
  const records = flatten(await api.getTree()); return { api, f, sub, a, b, c, records, map: new Map(records.map(n => [n.id, n])) };
}
describe('explorer navigation, scopes and sorting', () => {
  it('shows only top-level directories on first open and direct children on navigation', async () => { const { records, f, a, sub } = await fixture(); expect(explorerRows(records, undefined, '', 'browser').map(n => n.id)).toEqual(['bar-local', 'bar-account', 'policy']); expect(explorerRows(records, f.id, '', 'browser').map(n => n.id)).toEqual([sub.id, a.id]); });
  it('searches names and URLs case-insensitively in current descendants', async () => { const { records, f, a, b } = await fixture(); expect(explorerRows(records, f.id, 'EXAMPLE.COM/x', 'browser').map(n => n.id)).toEqual([b.id, a.id]); expect(explorerRows(records, f.id, 'aLPHa', 'browser').map(n => n.id)).toEqual([b.id]); });
  it('sorts a display copy without mutating the browser-order records', async () => { const { records, f, a, sub } = await fixture(); const original = records.map(n => n.id); expect(explorerRows(records, f.id, '', 'name').map(n => n.id)).toEqual([sub.id, a.id]); expect(records.map(n => n.id)).toEqual(original); });
  it('recovers the closest surviving ancestor after external deletion', async () => { const { map, f, sub } = await fixture(); const chain = ancestorIds(sub.id, map); map.delete(sub.id); expect(validFolder(sub.id, chain, map)).toBe(f.id); map.delete(f.id); expect(validFolder(sub.id, chain, map)).toBe('bar-local'); });
  it('combines dashboard filters and limits duplicate membership to the chosen scope', async () => { const { records, f, sub, a, b } = await fixture(); const results = new Map<string, CheckResult>(); expect(dashboardRows(records, results, { ...defaultFilter, folderId: f.id, type: 'bookmark', duplicate: 'yes', domain: 'EXAMPLE.com' }).map(n => n.id)).toEqual([b.id, a.id]); expect(dashboardRows(records, results, { ...defaultFilter, folderId: sub.id, duplicate: 'yes' })).toHaveLength(0); });
  it('excludes stale checks from coverage and abnormal counts', async () => { const { records, a } = await fixture(); const results = new Map([[a.id, { nodeId: a.id, status: 'network-error', stale: true } as CheckResult]]); expect(dashboardRows(records, results, { ...defaultFilter, status: 'checked' })).toHaveLength(0); expect(dashboardRows(records, results, { ...defaultFilter, status: 'issues' })).toHaveLength(0); expect(dashboardRows(records, results, { ...defaultFilter, status: 'stale' })).toHaveLength(1); });
});
describe('clipboard and drag intents', () => {
  it('rejects self/descendant, fixed sources, deleted sources and anchors within the selection', async () => { const { map, f, sub, a } = await fixture(); expect(validDrop({ parentId: sub.id }, [f.id], map)).toBe(false); expect(validDrop({ parentId: f.id }, ['gone'], map)).toBe(false); expect(validDrop({ parentId: f.id }, ['bar-local'], map)).toBe(false); expect(validDrop({ parentId: f.id, beforeId: a.id }, [a.id], map)).toBe(false); expect(validDrop({ parentId: sub.id }, [a.id], map)).toBe(true); });
  it('only clears successfully moved cut items and preserves a newer clipboard', async () => {
    const { a, b } = await fixture(); const clipboard = { kind: 'cut' as const, nodes: [expected(a), expected(b)], token: 'old' };
    const op = { steps: [{ state: 'done', kind: 'move', nodeId: a.id }, { state: 'conflict', kind: 'move', nodeId: b.id }] } as OperationRecord;
    expect(finishCut(clipboard, op, 'old')?.nodes.map(n => n.id)).toEqual([b.id]); expect(finishCut(clipboard, op, 'new')).toBe(clipboard);
  });
  it('selects only successfully created roots, excluding recycle containers and descendants', () => { const op = { steps: [{ kind: 'create', state: 'done', createdId: 'bin', systemRecycle: true }, { kind: 'create', state: 'done', createdId: 'root' }, { kind: 'create', state: 'done', createdId: 'child', parentRef: 'ref' }, { kind: 'create', state: 'failed', createdId: 'failed' }] } as OperationRecord; expect(completedIds(op)).toEqual(['root']); });
});
describe('virtual layout marquee geometry', () => {
  const rows = Array.from({ length: 10000 }, (_, i) => ({ id: String(i) } as BookmarkRecord));
  it('selects non-rendered grid items using content coordinates', () => { const layout = layoutFor(900, true); const r = itemRect(9500, layout); expect(marqueeIds(rows, layout, { x: r.x + 1, y: r.y + 1, width: 2, height: 2 })).toEqual(['9500']); });
  it('selects entire offscreen row ranges in list mode', () => { const layout = layoutFor(900, false); expect(marqueeIds(rows, layout, { x: 1, y: 9000 * 42, width: 800, height: 100 * 42 })).toHaveLength(100); });
  it('does not select tiles when the box only covers a gap', () => { const layout = layoutFor(900, true); expect(marqueeIds(rows, layout, { x: 16, y: 16, width: 3, height: 3 })).toHaveLength(0); });
});
