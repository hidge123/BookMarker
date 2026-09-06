import * as db from './store';
import { expected, flatten, matches, minimalSelection, treeDigest } from './tree';
import type { BookmarkRecord, BrowserNode, EditCommand, Expected, ImportNode, NodeMetadata, OperationRecord, OperationStep, Snapshot } from './types';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const step = (data: Omit<OperationStep, 'id' | 'state'>): OperationStep => ({ ...data, id: db.uid(), state: 'pending' });
export class ConflictError extends Error {}

export class BookmarkEngine {
  constructor(private api: typeof chrome.bookmarks, private notify: () => void = () => {}) {}
  async records() { return flatten(await this.api.getTree(), await db.all('metadata')); }
  async actual(id: string): Promise<Expected | undefined> {
    try { const [node] = await this.api.get(id); return node ? expected(node) : undefined; } catch { return undefined; }
  }
  async checkedNode(id: string, destination = false): Promise<BrowserNode> {
    const [node] = await this.api.get(id);
    if (!node || !node.parentId) throw new ConflictError('浏览器根目录不可修改');
    if (destination && node.url !== undefined) throw new ConflictError('目标不是文件夹');
    if (!destination && node.folderType) throw new ConflictError('浏览器固定目录不可修改');
    let p: BrowserNode | undefined = node;
    while (p) {
      if (p.unmodifiable || p.folderType === 'managed') throw new ConflictError('受管理节点为只读');
      if (!p.parentId) break;
      const parent: BrowserNode | undefined = (await this.api.get(p.parentId))[0];
      if (!destination && p.id === node.id && parent && !parent.parentId) throw new ConflictError('浏览器固定目录不可修改');
      p = parent;
    }
    return node;
  }
  async capture(node: Expected, subtree = false): Promise<Expected> {
    const current = await this.actual(node.id);
    if (!matches(current, node)) throw new ConflictError(`“${node.title}”已被外部修改，请刷新后重试`);
    if (subtree) { const [tree] = await this.api.getSubTree(node.id); return { ...node, treeHash: treeDigest(tree) }; }
    return node;
  }
  async snapshot(label: string, kind: Snapshot['kind'] = 'manual'): Promise<Snapshot> {
    if ((await db.all('operations')).some(o => ['queued', 'running', 'needs-review'].includes(o.status))) throw new ConflictError('请先完成或核对当前操作，再创建快照');
    const snapshot: Snapshot = { id: db.uid(), createdAt: await db.timestamp(), label, kind, profileId: await db.profileId(), tree: await this.api.getTree(), metadata: await db.all('metadata'), operationIds: (await db.all('operations')).filter(o => o.status === 'done' || o.status === 'partial').map(o => o.id) };
    await db.put('snapshots', snapshot);
    if (kind === 'daily') { const daily = (await db.all('snapshots')).filter(s => s.kind === 'daily').sort((a, b) => b.createdAt - a.createdAt); for (const old of daily.slice(30)) await db.remove('snapshots', old.id); }
    this.notify(); return snapshot;
  }
  async dailySnapshot() {
    if ((await db.all('operations')).some(o => ['queued', 'running', 'needs-review'].includes(o.status))) return;
    const today = new Date().toLocaleDateString('en-CA');
    if (!(await db.all('snapshots')).some(s => s.kind === 'daily' && new Date(s.createdAt).toLocaleDateString('en-CA') === today)) await this.snapshot(`每日备份 · ${today}`, 'daily');
  }
  async submit(command: EditCommand): Promise<OperationRecord> {
    if ((await db.all('operations')).some(o => ['queued', 'running', 'needs-review'].includes(o.status))) throw new ConflictError('上一个修改操作尚未完成，请在“操作与版本”中等待或核对后继续');
    const records = await this.records(); const byId = new Map(records.map(n => [n.id, n]));
    const metadata = new Map((await db.all('metadata')).map(n => [n.id, n]));
    const steps: OperationStep[] = []; const warnings: string[] = [];
    const recycleRefs = new Map<string, { parentId?: string; parentRef?: string }>();
    const requireNode = (id: string) => { const n = byId.get(id); if (!n || n.fixed || n.readOnly || metadata.get(id)?.recycleRegion) throw new ConflictError('节点不存在、为固定目录、回收站容器或受管理节点'); return n; };
    const requireFolder = (id: string) => { const n = byId.get(id); if (!n || n.url !== undefined || !n.parentId || n.readOnly) throw new ConflictError('目标目录不可写'); return n; };
    const recycle = (regionId: string) => {
      if (recycleRefs.has(regionId)) return recycleRefs.get(regionId)!;
      requireFolder(regionId);
      const existing = records.find(n => metadata.get(n.id)?.recycleRegion === regionId && n.parentId === regionId && n.url === undefined && !n.readOnly);
      const ref = existing ? { parentId: existing.id } : (() => { const s = step({ kind: 'create', parentId: regionId, title: 'BookMarker 回收站', systemRecycle: true, metadata: { recycleRegion: regionId } }); steps.push(s); return { parentRef: s.id }; })();
      recycleRefs.set(regionId, ref); return ref;
    };
    const trash = async (target: Expected, guard?: Expected, allowedDescendantIds?: string[]) => {
      const n = requireNode(target.id); if (n.inTrash && !guard) throw new ConflictError('该节点已在回收站');
      const regionId = guard ? byId.get(target.parentId!)?.regionId || n.regionId : n.regionId;
      steps.push(step({ kind: 'move', nodeId: n.id, expected: guard ?? await this.capture(target, !n.url), ...recycle(regionId), allowedDescendantIds, metadata: { trash: { parentId: target.parentId!, index: target.index, regionId, at: Date.now() } } }));
    };
    const inverse = async (operation: OperationRecord) => {
      const done = operation.steps.filter(s => s.state === 'done' && !s.systemRecycle);
      const created = new Set(done.filter(s => s.kind === 'create').map(s => s.createdId!));
      for (const s of [...done].reverse()) {
        if (s.kind === 'remove') { warnings.push('永久删除不可撤销：重建无法保留原 ID 与浏览器隐藏元数据。'); continue; }
        if (!s.after) continue;
        if (s.kind === 'create') {
          if (s.after.parentId && created.has(s.after.parentId)) continue;
          const node = byId.get(s.after.id);
          if (!node) { steps.push(step({ kind: 'move', nodeId: s.after.id, expected: s.after, parentId: s.after.parentId })); continue; }
          await trash(s.after, s.after, node.url === undefined ? [...created] : undefined);
        } else if (s.kind === 'update') {
          steps.push(step({ kind: 'update', nodeId: s.after.id, expected: s.after, title: s.title !== undefined ? s.before?.title : undefined, url: s.url !== undefined ? s.before?.url : undefined, metadata: s.metadataBefore ?? {} }));
        } else if (s.before) {
          let parentId = s.before.parentId!;
          if (!byId.has(parentId)) {
            const region = metadata.get(s.after.id)?.trash?.regionId ?? byId.get(s.after.id)?.regionId;
            if (!region) throw new ConflictError('原目录和原书签区域均已不存在');
            parentId = requireFolder(region).id; warnings.push('原目录已不存在，将恢复到来源书签区域。');
          }
          steps.push(step({ kind: 'move', nodeId: s.after.id, expected: s.after, parentId, index: s.before.index, metadata: s.metadataBefore ?? {} }));
        }
      }
    };
    let label = '';
    switch (command.kind) {
      case 'create':
        requireFolder(command.parentId); label = command.url === undefined ? '新建文件夹' : '新建书签';
        steps.push(step({ kind: 'create', parentId: command.parentId, title: command.title, url: command.url, metadata: { originalInput: command.url } })); break;
      case 'update':
        label = command.changes.length > 1 ? `批量重命名 ${command.changes.length} 项` : '编辑书签';
        for (const c of command.changes) { requireNode(c.expected.id); steps.push(step({ kind: 'update', nodeId: c.expected.id, expected: await this.capture(c.expected), title: c.title, url: c.url, metadata: c.url !== undefined ? { originalInput: c.url } : undefined })); } break;
      case 'move': {
        const dest = requireFolder(command.parentId); if (dest.inTrash) throw new ConflictError('请使用“移入回收站”以记录恢复位置');
        const nodes = minimalSelection(command.nodes, records); label = `移动 ${nodes.length} 项`;
        const movingIds = new Set(nodes.map(n => n.id));
        const remaining = records.filter(n => n.parentId === dest.id && !movingIds.has(n.id)).sort((a, b) => a.index - b.index);
        if (command.beforeId && !remaining.some(n => n.id === command.beforeId)) throw new ConflictError('目标锚点不存在、已移动或属于选中项目');
        const beforeId = command.beforeId ?? (command.index === undefined ? undefined : remaining[Math.max(0, command.index)]?.id);
        for (let i = 0; i < nodes.length; i++) { const n = requireNode(nodes[i].id); if (n.inTrash) throw new ConflictError('请先从回收站恢复'); steps.push(step({ kind: 'move', nodeId: n.id, expected: await this.capture(nodes[i], !n.url), parentId: dest.id, beforeId, atEnd: !beforeId })); } break;
      }
      case 'copy': {
        const dest = requireFolder(command.parentId); if (dest.inTrash) throw new ConflictError('不能复制到回收站');
        const nodes = minimalSelection(command.nodes, records); label = `复制 ${nodes.length} 项`;
        const names = new Set(records.filter(n => n.parentId === dest.id).map(n => n.title));
        for (const target of nodes) {
          const source = requireNode(target.id); if (source.inTrash) throw new ConflictError('请先从回收站恢复');
          let p: BookmarkRecord | undefined = dest;
          while (p) { if (p.id === source.id) throw new ConflictError('不能复制到自身或其子目录'); p = byId.get(p.parentId ?? ''); }
          const guard = await this.capture(target, source.url === undefined);
          const [tree] = await this.api.getSubTree(source.id);
          if (guard.treeHash && treeDigest(tree) !== guard.treeHash) throw new ConflictError('复制来源已被外部修改');
          let title = source.title;
          if (names.has(title)) { title = `${source.title} 副本`; let i = 2; while (names.has(title)) title = `${source.title} 副本 ${i++}`; }
          names.add(title);
          const add = (n: BrowserNode, parent: { parentId: string } | { parentRef: string }, name = n.title) => {
            const record = byId.get(n.id); if (!record || record.readOnly || record.inTrash) throw new ConflictError('复制子树包含不可复制的节点');
            const { id: _id, trash: _trash, recycleRegion: _recycle, ...meta } = metadata.get(n.id) ?? { id: n.id };
            const s = step({ kind: 'create', ...parent, title: name, url: n.url, copySource: n.id === source.id ? guard : expected(n), metadata: meta }); steps.push(s);
            for (const child of n.children ?? []) add(child, { parentRef: s.id });
          };
          add(tree, { parentId: dest.id }, title);
        }
        break;
      }
      case 'trash':
        label = `移入回收站 · ${command.nodes.length} 项`;
        for (const n of minimalSelection(command.nodes, records)) await trash(n); break;
      case 'restore':
        label = `恢复 ${command.nodes.length} 项`;
        for (const target of minimalSelection(command.nodes, records)) {
          const n = requireNode(target.id); const m = metadata.get(n.id); if (!n.inTrash || !m?.trash) throw new ConflictError('缺少原始位置信息，请恢复包含此项的上层目录');
          const original = byId.get(m.trash.parentId);
          const parentId = original && !original.inTrash && !original.readOnly && original.url === undefined ? original.id : requireFolder(m.trash.regionId).id;
          if (parentId !== m.trash.parentId) warnings.push('原目录不存在或不可写，已改为恢复到同一区域。');
          steps.push(step({ kind: 'move', nodeId: n.id, expected: await this.capture(target, !n.url), parentId, index: m.trash.index, metadata: { ...m, trash: undefined } }));
        } break;
      case 'purge':
        if (!command.confirmed) throw new Error('永久删除需要确认'); label = `永久删除 ${command.nodes.length} 项`;
        for (const target of minimalSelection(command.nodes, records)) { const n = requireNode(target.id); if (!n.inTrash) throw new ConflictError('只能永久删除回收站内的内容'); steps.push(step({ kind: 'remove', nodeId: n.id, expected: await this.capture(target, !n.url), irreversible: true })); } break;
      case 'import': {
        const destination = requireFolder(command.parentId); label = `导入 · ${command.parsed.source.name}`;
        await db.put('sources', command.parsed.source);
        const root = step({ kind: 'create', parentId: command.parentId, title: command.folderTitle, metadata: { sourceId: command.parsed.source.id } }); steps.push(root);
        const add = (nodes: ImportNode[], parentRef: string) => { for (const n of nodes) { const s = step({ kind: 'create', parentRef, title: n.title, url: n.url, importKey: n.key, importedMetadata: n.metadata, importRegionId: destination.regionId, metadata: { sourceId: command.parsed.source.id, sourcePath: n.sourcePath ?? n.key, originalInput: n.metadata?.originalInput ?? n.url, raw: n.raw ?? n.metadata } }); steps.push(s); if (n.children) add(n.children, s.id); } };
        add(command.parsed.nodes, root.id); warnings.push(...command.parsed.warnings); break;
      }
      case 'undo': {
        const o = await db.get('operations', command.operationId); if (!o) throw new Error('操作不存在');
        if ((await db.all('operations')).some(x => x.undoOf === o.id && !['cancelled'].includes(x.status))) throw new Error('此操作已提交撤销，请使用对应的重做');
        label = `撤销 · ${o.label}`; await inverse(o); break;
      }
      case 'redo': {
        const o = await db.get('operations', command.operationId); if (!o?.undoOf) throw new Error('请选择一条撤销记录进行重做');
        if ((await db.all('operations')).some(x => x.redoOf === o.id)) throw new Error('此撤销已重做'); label = `重做 · ${o.label}`; await inverse(o); break;
      }
      case 'rollback': {
        const s = await db.get('snapshots', command.snapshotId); if (!s || s.profileId !== await db.profileId()) throw new Error('跨配置快照请通过项目备份导入为新节点');
        const history = (await db.all('operations')).filter(o => o.createdAt > s.createdAt && !s.operationIds.includes(o.id)).sort((a, b) => b.createdAt - a.createdAt);
        if (history.some(o => ['queued', 'running', 'needs-review'].includes(o.status))) throw new Error('请先完成或核对未完成的操作');
        label = `回滚至 ${s.label}`; for (const o of history) await inverse(o); warnings.push('仅撤回此版本之后本工具已确认的变更；外部修改会作为冲突保留。'); break;
      }
    }
    if (!steps.length) throw new Error(warnings.join(' ') || '没有可执行的变更');
    if (steps.length >= 20 || command.kind === 'rollback' || command.kind === 'purge') await this.snapshot(`操作前 · ${label}`, 'automatic');
    const op: OperationRecord = { id: db.uid(), label, createdAt: await db.timestamp(), profileId: await db.profileId(), status: 'queued', steps, warnings, reverting: ['undo', 'redo', 'rollback'].includes(command.kind), undoOf: command.kind === 'undo' ? command.operationId : undefined, redoOf: command.kind === 'redo' ? command.operationId : undefined };
    await db.put('operations', op); this.notify(); return op;
  }
  async verifyGuard(s: OperationStep) {
    if (!s.expected || !s.nodeId) return;
    const current = await this.actual(s.nodeId);
    if (!matches(current, s.expected)) throw new ConflictError(`“${s.expected.title}”已变更或不存在；未覆盖外部修改`);
    if (s.allowedDescendantIds) {
      const allowed = new Set(s.allowedDescendantIds); const [tree] = await this.api.getSubTree(s.nodeId);
      const walk = (n: BrowserNode): boolean => allowed.has(n.id) && (n.children ?? []).every(walk);
      if (!walk(tree)) throw new ConflictError('新建目录中存在不属于本次创建的节点，无法安全撤销');
    }
    if (s.expected.treeHash) { const [tree] = await this.api.getSubTree(s.nodeId); if (treeDigest(tree) !== s.expected.treeHash) throw new ConflictError('目录内容发生外部变更'); }
  }
  async runStep(op: OperationRecord, s: OperationStep): Promise<void> {
    let apiReturned = false;
    try {
      if (s.copySource) {
        await this.checkedNode(s.copySource.id);
        const source = await this.actual(s.copySource.id);
        if (!matches(source, s.copySource, true)) throw new ConflictError('复制来源已被外部修改或删除');
        if (s.copySource.treeHash) { const [tree] = await this.api.getSubTree(s.copySource.id); if (treeDigest(tree) !== s.copySource.treeHash) throw new ConflictError('复制来源的子树已被外部修改'); }
      }
      if (s.parentRef) { const parent = op.steps.find(p => p.id === s.parentRef); if (parent?.state !== 'done' || !parent.createdId) throw new ConflictError('依赖目录未成功创建'); s.parentId = parent.createdId; }
      if (s.kind !== 'create') { await this.checkedNode(s.nodeId!); await this.verifyGuard(s); }
      if (s.parentId) await this.checkedNode(s.parentId, true);
      if (s.kind === 'move') {
        let p = s.parentId; while (p) { if (p === s.nodeId) throw new ConflictError('不能移动到自身或其子目录'); p = (await this.actual(p))?.parentId; }
      }
      s.before = s.nodeId ? await this.actual(s.nodeId) : undefined;
      s.metadataBefore = s.nodeId ? await db.get('metadata', s.nodeId) : undefined;
      s.startedAt = Date.now(); s.state = 'running';
      if (s.beforeId) { const anchor = await this.actual(s.beforeId); if (!anchor || anchor.parentId !== s.parentId) throw new ConflictError('目标排序位置已被外部移动或删除'); s.index = anchor.index - (s.before && s.before.parentId === s.parentId && s.before.index < anchor.index ? 1 : 0); }
      else if (s.atEnd) s.index = undefined;
      if ((s.index !== undefined || s.kind === 'move') && s.parentId) { const children = await this.api.getChildren(s.parentId); s.index = Math.max(0, Math.min(s.index ?? children.length, children.length - (s.before?.parentId === s.parentId ? 1 : 0))); }
      await db.put('operations', op); // Durable intent MUST precede the browser API.
      let node: BrowserNode | undefined;
      if (s.kind === 'create') node = await this.api.create({ parentId: s.parentId, index: s.index, title: s.title ?? '', ...(s.url !== undefined ? { url: s.url } : {}) });
      if (s.kind === 'update') node = await this.api.update(s.nodeId!, { ...(s.title !== undefined ? { title: s.title } : {}), ...(s.url !== undefined ? { url: s.url } : {}) });
      if (s.kind === 'move') {
        // Chromium's API index addresses the list BEFORE removing the source.
        // The journal stores the desired final index for reliable recovery/undo.
        const apiIndex = s.index === undefined ? undefined : s.index + (s.before && s.before.parentId === s.parentId && s.before.index < s.index ? 1 : 0);
        node = await this.api.move(s.nodeId!, { parentId: s.parentId, index: apiIndex });
      }
      if (s.kind === 'remove') await this.api.removeTree(s.nodeId!);
      apiReturned = true;
      if (node) { s.nodeId = node.id; if (s.kind === 'create') s.createdId = node.id; s.after = expected(node); }
      await this.commitStep(op, s);
    } catch (error) {
      s.state = apiReturned ? 'needs-review' : error instanceof ConflictError ? 'conflict' : 'failed'; s.error = errorText(error);
      await db.put('operations', op); this.notify();
    }
  }
  private async commitStep(op: OperationRecord, s: OperationStep) {
    if (s.after && s.expected?.treeHash) { const [tree] = await this.api.getSubTree(s.after.id); s.after.treeHash = treeDigest(tree); }
    // Account for index shifts caused by this exact mutation, without absorbing other fields.
    for (const next of op.reverting ? [] : op.steps) {
      if (next.state !== 'pending' || !next.expected || next === s) continue;
      const e = next.expected; const b = s.before; const a = s.after;
      if (e.id === s.nodeId) { /* Successive inverse steps already carry their own guards. */ }
      else {
        if ((s.kind === 'move' || s.kind === 'remove') && b && e.parentId === b.parentId && e.index > b.index) e.index--;
        if ((s.kind === 'move' || s.kind === 'create') && a && e.parentId === a.parentId && e.index >= a.index) e.index++;
      }
    }
    if (s.after && s.kind !== 'remove') {
      const restoring = op.undoOf || op.redoOf || (s.kind === 'move' && s.metadata && 'trash' in s.metadata && !s.metadata.trash);
      s.metadataAfter = { ...(restoring ? {} : s.metadataBefore), ...s.metadata, id: s.after.id };
      if (s.url !== undefined && s.after.url !== s.url) op.warnings.push(`浏览器将 URL 保存为：${s.after.url}；原始输入已保留。`);
    }
    s.state = 'done'; s.completedAt = Date.now(); s.error = undefined;
    await db.write([['operations', op], ...(s.metadataAfter ? [['metadata', s.metadataAfter] as ['metadata', NodeMetadata]] : [])]);
    this.notify();
  }
  async recover() {
    for (const op of await db.all('operations')) {
      if (!['queued', 'running'].includes(op.status)) continue;
      for (const s of op.steps.filter(s => s.state === 'running')) {
        const current = s.nodeId ? await this.actual(s.nodeId) : undefined;
        if (s.kind === 'create') { s.state = 'needs-review'; s.error = '后台在新建确认前中断。请核对目录后关联已有节点，或跳过本步；不会自动再次创建。'; }
        else if (s.kind === 'remove' && !current) { await this.commitStep(op, s); }
        else if (current && s.before) {
          const desired = { ...s.before, ...(s.kind === 'update' ? { title: s.title ?? s.before.title, url: s.url ?? s.before.url } : { parentId: s.parentId, index: s.index ?? current.index }) };
          if (s.kind !== 'remove' && matches(current, desired) && !matches(current, s.before)) {
            if (s.expected?.treeHash) {
              const [tree] = await this.api.getSubTree(current.id);
              if (treeDigest({ ...tree, parentId: s.before.parentId }) !== s.expected.treeHash) { s.state = 'conflict'; s.error = '后台中断期间目录内容发生变更，无法确认移动'; continue; }
            }
            s.after = current; await this.commitStep(op, s);
          }
          else if (matches(current, s.before)) s.state = 'pending';
          else { s.state = 'conflict'; s.error = '重启后实际状态与修改前、预期修改后均不一致，请核对。'; }
        } else { s.state = 'conflict'; s.error = '重启后无法确认节点状态'; }
      }
      op.status = op.steps.some(s => s.state === 'needs-review') ? 'needs-review' : 'queued'; await db.put('operations', op);
    }
  }
  async pump(): Promise<boolean> {
    const op = (await db.all('operations')).filter(o => ['queued', 'running'].includes(o.status)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!op) return false;
    op.status = 'running'; const start = Date.now(); let count = 0;
    for (const s of op.steps) {
      if (s.state !== 'pending') continue;
      await this.runStep(op, s); count++;
      if (s.state as string === 'needs-review' || count >= 25 || Date.now() - start > 8000) break;
    }
    if (op.steps.some(s => s.state === 'needs-review')) op.status = 'needs-review';
    else if (op.steps.some(s => s.state === 'pending')) op.status = 'queued';
    else {
      // Foreign IDs remain archival data and never become browser mutation targets.
      const imported = new Map(op.steps.filter(s => s.state === 'done' && s.importKey).map(s => [s.importKey!, s.createdId!]));
      for (const s of op.steps) if (s.state === 'done' && s.metadataAfter && s.importedMetadata && s.importRegionId) {
        const archived = s.importedMetadata;
        if (archived.recycleRegion) s.metadataAfter.recycleRegion = s.importRegionId;
        if (archived.trash) s.metadataAfter.trash = { ...archived.trash, regionId: s.importRegionId, parentId: imported.get(archived.trash.parentId) ?? s.importRegionId };
        await db.put('metadata', s.metadataAfter);
      }
      op.status = op.steps.every(s => s.state === 'done') ? 'done' : 'partial'; op.completedAt = Date.now();
    }
    await db.put('operations', op);
    if (op.completedAt && (await db.all('operations')).filter(o => o.completedAt).length % 50 === 0) await this.snapshot('每 50 次操作自动备份', 'automatic');
    this.notify(); return true;
  }
  async resolve(operationId: string, stepId: string, action: 'skip' | 'adopt', nodeId?: string) {
    const op = await db.get('operations', operationId); const s = op?.steps.find(s => s.id === stepId);
    if (!op || !s || s.state !== 'needs-review') throw new Error('没有待核对的步骤');
    if (action === 'skip') { s.state = 'skipped'; s.error = '用户核对后跳过；已存在的节点不会被删除。'; }
    else {
      if (s.kind !== 'create' || !nodeId) throw new Error('请选择已创建的节点');
      await this.checkedNode(nodeId); const n = await this.actual(nodeId);
      if (!n || n.parentId !== s.parentId || n.title !== s.title || n.url !== s.url) throw new ConflictError('关联节点的目录、标题或 URL 与计划不符');
      if (op.steps.some(other => other.id !== s.id && other.createdId === nodeId)) throw new ConflictError('节点已关联到其他步骤');
      s.createdId = nodeId; s.nodeId = nodeId; s.after = n; await this.commitStep(op, s);
    }
    op.status = op.steps.some(s => s.state === 'needs-review') ? 'needs-review' : 'queued'; await db.put('operations', op); this.notify();
  }
}
