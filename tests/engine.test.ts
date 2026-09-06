import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { BookmarkEngine } from '../src/engine';
import * as db from '../src/store';
import { expected, flatten } from '../src/tree';
import { MockBookmarks } from './mock-browser';
import type { EditCommand, OperationRecord } from '../src/types';
import { fromBrowserTree } from '../src/formats';

let api: MockBookmarks; let engine: BookmarkEngine;
beforeEach(async () => { const database = await db.database(); for (const table of [...database.objectStoreNames]) await new Promise<void>(resolve => { const t = database.transaction(table, 'readwrite'); t.objectStore(table).clear(); t.oncomplete = () => resolve(); }); api = new MockBookmarks(); engine = new BookmarkEngine(api.asApi()); });
async function execute(command: EditCommand): Promise<OperationRecord> { const op = await engine.submit(command); for (let i = 0; i < 100; i++) { await engine.pump(); const value = (await db.get('operations', op.id))!; if (!['queued', 'running'].includes(value.status)) return value; } throw new Error('Did not complete'); }
async function create(title = '文档', parentId = 'bar-local', url: string | undefined = 'https://example.com/a?x=1#t') { return api.create({ parentId, title, url }); }

describe('browser authority and safeguards', () => {
  it('recognizes arbitrary roots, account regions and inherited management', async () => { const nodes = flatten(await api.getTree()); expect(nodes.find(n => n.id === 'bar-account')).toMatchObject({ fixed: true, readOnly: false, regionId: 'bar-account' }); expect(nodes.find(n => n.id === 'policy-link')?.readOnly).toBe(true); });
  it('rejects fixed roots and managed children before logging mutations', async () => { const [fixed] = await api.get('bar-local'); await expect(engine.submit({ kind: 'update', changes: [{ expected: expected(fixed), title: 'changed' }] })).rejects.toThrow(); const [managed] = await api.get('policy-link'); await expect(engine.submit({ kind: 'trash', nodes: [expected(managed)] })).rejects.toThrow(); expect(await db.all('operations')).toHaveLength(0); });
  it('does not overwrite external edits at submission or execution', async () => { const n = await create(); const op = await engine.submit({ kind: 'update', changes: [{ expected: expected(n), title: 'ours' }] }); await api.update(n.id, { title: 'external' }); await engine.pump(); expect((await db.get('operations', op.id))?.steps[0].state).toBe('conflict'); expect((await api.get(n.id))[0].title).toBe('external'); await expect(engine.submit({ kind: 'trash', nodes: [expected(n)] })).rejects.toThrow('外部'); });
  it('checks destination ancestry, blocks descendant cycles', async () => { const folder = await api.create({ title: '父', parentId: 'bar-local' }); const child = await api.create({ title: '子', parentId: folder.id }); const result = await execute({ kind: 'move', nodes: [expected(folder)], parentId: child.id }); expect(result.steps[0].state).toBe('conflict'); });
  it('writes only edited fields and keeps raw URL input', async () => { const n = await create(); const op = await execute({ kind: 'update', changes: [{ expected: expected(n), url: 'https://EXAMPLE.com' }] }); expect(op.steps[0].after?.url).toBe('https://example.com/'); expect((await api.get(n.id))[0].title).toBe(n.title); expect((await db.get('metadata', n.id))?.originalInput).toBe('https://EXAMPLE.com'); });
});
describe('recycle bin and history', () => {
  it('moves and restores original node IDs, scoped to the source region', async () => { const a = await create(); const b = await create('账号', 'bar-account'); const op = await execute({ kind: 'trash', nodes: [expected(a), expected(b)] }); expect(op.status).toBe('done'); const meta = await db.all('metadata'); expect(meta.filter(m => m.recycleRegion).map(m => m.recycleRegion).sort()).toEqual(['bar-account', 'bar-local']); const moved = await api.get([a.id, b.id]); await execute({ kind: 'restore', nodes: moved.map(expected) }); expect((await api.get(a.id))[0].parentId).toBe('bar-local'); expect((await api.get(b.id))[0].parentId).toBe('bar-account'); });
  it('deduplicates ancestor/child selections and preserves folder contents', async () => { const folder = await api.create({ title: '目录', parentId: 'bar-local' }); const n = await create('子项', folder.id); const op = await execute({ kind: 'trash', nodes: [expected(folder), expected(n)] }); expect(op.status).toBe('done'); expect(op.steps.filter(s => s.kind === 'move')).toHaveLength(1); expect((await api.get(n.id))[0].parentId).toBe(folder.id); });
  it('falls back to same region when original parent is gone', async () => { const folder = await api.create({ title: '目录', parentId: 'bar-account' }); const n = await create('子', folder.id); await execute({ kind: 'trash', nodes: [expected(n)] }); await api.removeTree(folder.id); const op = await execute({ kind: 'restore', nodes: (await api.get(n.id)).map(expected) }); expect(op.warnings.join('')).toContain('同一区域'); expect((await api.get(n.id))[0].parentId).toBe('bar-account'); });
  it('requires explicit confirmation and only purges trash', async () => { const n = await create(); await expect(execute({ kind: 'purge', nodes: [expected(n)] })).rejects.toThrow('确认'); await expect(execute({ kind: 'purge', nodes: [expected(n)], confirmed: true })).rejects.toThrow('回收站'); await execute({ kind: 'trash', nodes: [expected(n)] }); await execute({ kind: 'purge', nodes: (await api.get(n.id)).map(expected), confirmed: true }); await expect(api.get(n.id)).rejects.toThrow(); expect((await db.all('snapshots')).length).toBeGreaterThan(0); });
  it('undoes and redoes edits without rebuilding', async () => { const n = await create(); const op = await execute({ kind: 'update', changes: [{ expected: expected(n), title: 'new' }] }); const undone = await execute({ kind: 'undo', operationId: op.id }); expect((await api.get(n.id))[0].title).toBe(n.title); await execute({ kind: 'redo', operationId: undone.id }); expect((await api.get(n.id))[0].title).toBe('new'); });
  it('undoes creation via trash and redoes via the same node ID', async () => { const op = await execute({ kind: 'create', parentId: 'bar-local', title: 'new', url: 'https://example.com/' }); const id = op.steps[0].createdId!; const undone = await execute({ kind: 'undo', operationId: op.id }); expect((await api.get(id))[0].parentId).not.toBe('bar-local'); const redo = await execute({ kind: 'redo', operationId: undone.id }); expect(redo.status).toBe('done'); expect((await api.get(id))[0].parentId).toBe('bar-local'); });
  it('preserves external changes when undoing', async () => { const n = await create(); const op = await execute({ kind: 'update', changes: [{ expected: expected(n), title: 'ours' }] }); await api.update(n.id, { title: 'someone else' }); const undo = await execute({ kind: 'undo', operationId: op.id }); expect(undo.steps[0].state).toBe('conflict'); expect((await api.get(n.id))[0].title).toBe('someone else'); });
  it('rolls back logged edits in reverse order as a new operation', async () => { const n = await create(); const snapshot = await engine.snapshot('before'); await new Promise(r => setTimeout(r, 2)); await execute({ kind: 'update', changes: [{ expected: expected(n), title: 'one' }] }); await execute({ kind: 'update', changes: [{ expected: expected((await api.get(n.id))[0]), title: 'two' }] }); const rolled = await execute({ kind: 'rollback', snapshotId: snapshot.id }); expect(rolled.status).toBe('done'); expect((await api.get(n.id))[0].title).toBe(n.title); expect(rolled.label).toContain('回滚'); });
});
describe('durable operations', () => {
  it('blocks interleaved commands and snapshots at a partial operation boundary', async () => { await engine.submit({ kind: 'create', parentId: 'bar-local', title: 'queued' }); await expect(engine.submit({ kind: 'create', parentId: 'bar-local', title: 'second' })).rejects.toThrow('尚未完成'); await expect(engine.snapshot('mid-batch')).rejects.toThrow('先完成'); });
  it('rolls back folder creation followed by a separately created child', async () => { const snapshot = await engine.snapshot('empty'); const f = await execute({ kind: 'create', parentId: 'bar-local', title: 'created folder' }); const folderId = f.steps[0].createdId!; await execute({ kind: 'create', parentId: folderId, title: 'child', url: 'https://example.com' }); const result = await execute({ kind: 'rollback', snapshotId: snapshot.id }); expect(result.status).toBe('done'); const records = await engine.records(); expect(records.find(n => n.id === folderId)?.inTrash).toBe(true); });
  it('rolls back a create followed by trash without rebuilding the created node', async () => { const snapshot = await engine.snapshot('empty'); const created = await execute({ kind: 'create', parentId: 'bar-local', title: 'created', url: 'https://example.com' }); const id = created.steps[0].createdId!; await execute({ kind: 'trash', nodes: (await api.get(id)).map(expected) }); const result = await execute({ kind: 'rollback', snapshotId: snapshot.id }); expect(result.status).toBe('done'); expect((await engine.records()).find(n => n.id === id)?.inTrash).toBe(true); });
  it('rejects undo of a created folder containing external nodes', async () => { const created = await execute({ kind: 'create', parentId: 'bar-local', title: 'created folder' }); const id = created.steps[0].createdId!; await create('external child', id); const result = await execute({ kind: 'undo', operationId: created.id }); expect(result.status).toBe('partial'); expect(result.steps.at(-1)?.state).toBe('conflict'); expect((await api.get(id))[0].parentId).toBe('bar-local'); });
  it('remaps backup recycle metadata to newly created IDs and the destination region', async () => {
    const original = new MockBookmarks(); const folder = await original.create({ parentId: 'bar-account', title: '原目录' }); const bin = await original.create({ parentId: 'bar-account', title: 'BookMarker 回收站' }); const trashed = await original.create({ parentId: bin.id, title: '待恢复', url: 'https://example.com/' });
    const nodes = fromBrowserTree(await original.getTree(), [{ id: bin.id, recycleRegion: 'bar-account' }, { id: trashed.id, trash: { parentId: folder.id, index: 0, regionId: 'bar-account', at: 1 } }]);
    const op = await execute({ kind: 'import', parentId: 'bar-local', folderTitle: '项目恢复', parsed: { format: 'BookMarker 项目 ZIP', nodes, warnings: [], source: { id: 'source', name: 'archive.zip', bytes: [1, 2], sha256: 'fixture', format: 'zip', importedAt: 1 } } }); expect(op.status).toBe('done');
    const imported = (await engine.records()).find(n => n.title === '待恢复')!; expect(imported.inTrash).toBe(true);
    const metadata = (await db.get('metadata', imported.id))!; expect(metadata.trash?.regionId).toBe('bar-local'); expect(metadata.trash?.parentId).toBe((await engine.records()).find(n => n.title === '原目录')?.id);
    const restored = await execute({ kind: 'restore', nodes: [expected(imported)] }); expect(restored.status).toBe('done'); expect((await api.get(imported.id))[0].parentId).toBe(metadata.trash?.parentId);
  });
  it('retains only the latest 30 daily snapshots', async () => { for (let i = 0; i < 32; i++) await engine.snapshot(`day-${i}`, 'daily'); expect((await db.all('snapshots')).filter(s => s.kind === 'daily')).toHaveLength(30); });
  it('reports partial batch failures individually', async () => { const a = await create('a'); const b = await create('b'); api.failTitle = 'bad'; const op = await execute({ kind: 'update', changes: [{ expected: expected(a), title: 'good' }, { expected: expected(b), title: 'bad' }] }); expect(op.status).toBe('partial'); expect(op.steps.map(s => s.state)).toEqual(['done', 'failed']); });
  it('sorts siblings without self-generated index conflicts', async () => { const ns = await Promise.all(['c', 'b', 'a'].map(t => create(t))); const op = await execute({ kind: 'move', nodes: ns.reverse().map(expected), parentId: 'bar-local', index: 0 }); expect(op.status).toBe('done'); expect((await api.getChildren('bar-local')).map(n => n.title)).toEqual(['a', 'b', 'c']); });
  it('moves a selected block down without changing its internal order', async () => { const ns = await Promise.all(['a', 'b', 'c', 'd'].map(t => create(t))); const op = await execute({ kind: 'move', nodes: ns.slice(0, 2).map(expected), parentId: 'bar-local', index: 1 }); expect(op.status).toBe('done'); expect((await api.getChildren('bar-local')).map(n => n.title)).toEqual(['c','a','b','d']); const undo = await execute({ kind: 'undo', operationId: op.id }); expect(undo.status).toBe('done'); expect((await api.getChildren('bar-local')).map(n => n.title)).toEqual(['a','b','c','d']); });
  it('pauses an unconfirmed create after restart instead of duplicating it', async () => { const op = await engine.submit({ kind: 'create', parentId: 'bar-local', title: 'new', url: 'https://example.com/' }); op.status = 'running'; op.steps[0].state = 'running'; await db.put('operations', op); const actual = await api.create({ parentId: 'bar-local', title: 'new', url: 'https://example.com/' }); const restarted = new BookmarkEngine(api.asApi()); await restarted.recover(); await restarted.pump(); expect((await db.get('operations', op.id))?.status).toBe('needs-review'); expect(await api.getChildren('bar-local')).toHaveLength(1); await restarted.resolve(op.id, op.steps[0].id, 'adopt', actual.id); await restarted.pump(); expect((await db.get('operations', op.id))?.status).toBe('done'); });
  it('reconciles a confirmed-looking update after worker interruption', async () => { const n = await create(); const op = await engine.submit({ kind: 'update', changes: [{ expected: expected(n), title: 'after' }] }); op.status = 'running'; op.steps[0].state = 'running'; op.steps[0].before = expected(n); await db.put('operations', op); await api.update(n.id, { title: 'after' }); await new BookmarkEngine(api.asApi()).recover(); await engine.pump(); expect((await db.get('operations', op.id))?.status).toBe('done'); });
  it('rejects a changed descendant when moving a folder', async () => { const f = await api.create({ parentId: 'bar-local', title: 'folder' }); const n = await create('child', f.id); const op = await engine.submit({ kind: 'trash', nodes: [expected(f)] }); await api.update(n.id, { title: 'external' }); await engine.pump(); expect((await db.get('operations', op.id))?.steps.at(-1)?.state).toBe('conflict'); expect((await api.get(f.id))[0].parentId).toBe('bar-local'); });
});

describe('copy and anchored insertion', () => {
  it('copies a nested subtree in order with new IDs, metadata references, and no check results', async () => {
    const f = await api.create({ title: '设计', parentId: 'bar-local' });
    const a = await create('a', f.id); const sub = await api.create({ title: '子目录', parentId: f.id }); const b = await create('b', sub.id);
    await db.put('metadata', { id: b.id, sourceId: 'original-file', sourcePath: '/folder/b', raw: { tags: ['设计'] } });
    const before = await api.getSubTree(f.id);
    const op = await execute({ kind: 'copy', nodes: [expected(f), expected(a)], parentId: 'bar-local' });
    expect(op.status).toBe('done'); expect(op.steps).toHaveLength(4);
    expect(op.steps[0].copySource?.treeHash).toBeDefined(); expect(op.steps.slice(1).every(s => !s.copySource?.treeHash)).toBe(true);
    const id = op.steps[0].createdId!; const [copy] = await api.getSubTree(id);
    expect(copy.title).toBe('设计 副本'); expect(copy.children?.map(n => n.title)).toEqual(['a', '子目录']);
    expect(copy.children?.[1].children?.[0].title).toBe('b'); expect(copy.children?.[0].id).not.toBe(a.id);
    expect(await api.getSubTree(f.id)).toEqual(before);
    expect(await db.get('metadata', copy.children![1].children![0].id)).toMatchObject({ sourceId: 'original-file', sourcePath: '/folder/b', raw: { tags: ['设计'] } });
    expect(await db.all('results')).toHaveLength(0);
    const undo = await execute({ kind: 'undo', operationId: op.id }); expect(undo.status).toBe('done');
    expect((await engine.records()).find(n => n.id === id)?.inTrash).toBe(true);
    expect((await execute({ kind: 'redo', operationId: undo.id })).status).toBe('done'); expect((await api.get(id))[0].parentId).toBe('bar-local');
  });
  it('reserves incrementing duplicate names and retains names at a new destination', async () => {
    const a = await create('a'); const dest = await api.create({ title: 'dest', parentId: 'bar-local' });
    await execute({ kind: 'copy', nodes: [expected(a)], parentId: 'bar-local' }); await execute({ kind: 'copy', nodes: [expected(a)], parentId: 'bar-local' });
    expect((await api.getChildren('bar-local')).map(n => n.title)).toEqual(['a', 'dest', 'a 副本', 'a 副本 2']);
    const op = await execute({ kind: 'copy', nodes: [expected(a)], parentId: dest.id }); expect(op.steps[0].after?.title).toBe('a');
  });
  it('rejects copying into self, descendants, managed regions, or from deleted sources before submission', async () => {
    const f = await api.create({ title: 'parent', parentId: 'bar-local' }); const child = await api.create({ title: 'child', parentId: f.id });
    for (const parentId of [f.id, child.id, 'policy']) await expect(engine.submit({ kind: 'copy', nodes: [expected(f)], parentId })).rejects.toThrow();
    await api.removeTree(f.id); await expect(engine.submit({ kind: 'copy', nodes: [expected(f)], parentId: 'bar-local' })).rejects.toThrow();
    expect(await db.all('operations')).toHaveLength(0);
  });
  it('rejects a changed copy subtree before creating any nodes', async () => {
    const f = await api.create({ title: 'folder', parentId: 'bar-local' }); const c = await create('before', f.id);
    const op = await engine.submit({ kind: 'copy', nodes: [expected(f)], parentId: 'bar-account' }); await api.update(c.id, { title: 'external' });
    await engine.pump(); expect((await db.get('operations', op.id))?.status).toBe('partial'); expect(await api.getChildren('bar-account')).toHaveLength(0);
  });
  it('checks each copied child at execution without repeating the entire subtree in every step', async () => {
    const f = await api.create({ title: 'folder', parentId: 'bar-local' }); const c = await create('child', f.id);
    const op = await engine.submit({ kind: 'copy', nodes: [expected(f)], parentId: 'bar-account' });
    await engine.runStep(op, op.steps[0]); await api.update(c.id, { title: 'external' }); await engine.runStep(op, op.steps[1]);
    expect(op.steps[0].state).toBe('done'); expect(op.steps[1].state).toBe('conflict'); expect(await api.getChildren(op.steps[0].createdId!)).toHaveLength(0);
    expect((await api.get(c.id))[0].title).toBe('external');
  });
  it('does not repeat uncertain copies after restart and resumes dependent children after adoption', async () => {
    const f = await api.create({ title: 'folder', parentId: 'bar-local' }); await create('child', f.id);
    const op = await engine.submit({ kind: 'copy', nodes: [expected(f)], parentId: 'bar-account' });
    const s = op.steps[0]; op.status = 'running'; s.state = 'running'; await db.put('operations', op);
    const actual = await api.create({ title: s.title, parentId: s.parentId });
    await engine.recover(); await engine.pump(); expect((await db.get('operations', op.id))?.status).toBe('needs-review');
    expect(await api.getChildren('bar-account')).toHaveLength(1);
    await engine.resolve(op.id, s.id, 'adopt', actual.id); await engine.pump();
    expect((await db.get('operations', op.id))?.status).toBe('done'); expect(await api.getChildren(actual.id)).toHaveLength(1);
  });
  it('keeps successful copy roots and skips dependent nodes when a parent fails', async () => {
    const a = await api.create({ title: 'bad', parentId: 'bar-local' }); await create('child', a.id); const b = await create('good'); api.failTitle = 'bad';
    const op = await execute({ kind: 'copy', nodes: [expected(a), expected(b)], parentId: 'bar-account' });
    expect(op.status).toBe('partial'); expect(op.steps.map(s => s.state)).toEqual(['failed', 'conflict', 'done']); expect((await api.getChildren('bar-account')).map(n => n.title)).toEqual(['good']);
  });
  it('inserts blocks before live anchors and at the tail', async () => {
    const ns = await Promise.all(['a', 'b', 'c', 'd'].map(t => create(t)));
    const op = await execute({ kind: 'move', nodes: ns.slice(0, 2).map(expected), parentId: 'bar-local', beforeId: ns[3].id });
    expect(op.status).toBe('done'); expect((await api.getChildren('bar-local')).map(n => n.title)).toEqual(['c', 'a', 'b', 'd']);
    await execute({ kind: 'move', nodes: (await api.get(ns[2].id)).map(expected), parentId: 'bar-local' });
    expect((await api.getChildren('bar-local')).map(n => n.title)).toEqual(['a', 'b', 'd', 'c']);
  });
  it('rejects invalid anchors and protects an anchor moved after submission', async () => {
    const a = await create('a'); const b = await create('b');
    await expect(engine.submit({ kind: 'move', nodes: [expected(a)], parentId: 'bar-local', beforeId: a.id })).rejects.toThrow('锚点');
    const op = await engine.submit({ kind: 'move', nodes: [expected(a)], parentId: 'bar-local', beforeId: b.id }); await api.move(b.id, { parentId: 'bar-account' }); await engine.pump();
    expect((await db.get('operations', op.id))?.steps[0].state).toBe('conflict'); expect((await api.get(a.id))[0].parentId).toBe('bar-local');
  });
});
