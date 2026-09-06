import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Bookmark, BookOpen, Search, Plus, Upload, Download, Folder, ChevronRight, CheckCheck, Trash2, Copy, History, Settings2, X, ShieldCheck, Globe, Archive, Check, LoaderCircle, ArrowLeft, ArrowRight, ArrowUp, LayoutGrid, List, Scissors, Ellipsis } from 'lucide-react';
import { isExtension, request } from '../client';
import { CHECK_PERMISSIONS } from '../checker';
import { descendants, expected, flatten, minimalSelection, renamePreview, type RenameRule } from '../tree';
import { encodeBackup, exportHtml, importStats, parseFile } from '../formats';
import { backupTransfer, importTransfer } from '../transfers';
import { get, put } from '../store';
import { ancestorIds, completedIds, dashboardRows, defaultExplorer, defaultFilter, explorerRows, finishCut, validDrop, validFolder, type ClipboardState, type DashboardFilter, type ExplorerState, type LocationState } from '../explorer';
import { DEFAULT_SETTINGS, type AppState, type BookmarkRecord, type CheckResult, type EditCommand, type OperationRecord, type ParsedImport, type Settings } from '../types';
import { Modal, Notice } from './components';
import { DirectoryTree, ExplorerItems, type DragController } from './Explorer';
import { DashboardControls } from './Dashboard';
import { Details } from './Details';
import { HistoryView } from './HistoryView';

type View = 'library' | 'dashboard' | 'trash' | 'history';
type Dialog = 'new-bookmark' | 'new-folder' | 'move' | 'rename' | 'import' | 'export' | 'settings' | 'check' | 'purge' | 'snapshot' | 'help' | 'properties' | null;
const initial: AppState = { tree: [], metadata: [], operations: [], snapshots: [], results: [], jobs: [], settings: DEFAULT_SETTINGS, profileId: '' };
const viewLabels: Record<View, string> = { library: '书签管理器', dashboard: '数据看板', trash: '回收站', history: '操作与版本' };
function download(bytes: Uint8Array | string, name: string, type: string) { const blob = new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes).buffer], { type }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export default function App() {
  const [state, setState] = useState(initial); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>('library'); const [explorer, setExplorer] = useState<ExplorerState>(defaultExplorer); const [prefsReady, setPrefsReady] = useState(false);
  const folderId = explorer.folderId; const query = explorer.query; const search = useDeferredValue(query);
  const [filter, setFilter] = useState<DashboardFilter>(defaultFilter); const deferredFilter = useDeferredValue(filter);
  const [selected, setSelected] = useState<Set<string>>(new Set()); const anchor = useRef<string | undefined>(undefined);
  const [dialog, setDialog] = useState<Dialog>(null); const [renameId, setRenameId] = useState<string>();
  const [error, setError] = useState(''); const [toast, setToast] = useState(''); const [context, setContext] = useState<{ x: number; y: number; node?: BookmarkRecord }>();
  const [clipboard, setClipboard] = useState<ClipboardState>(); const [dragIds, setDragIds] = useState<string[]>([]); const dragging = useRef<string[]>([]);
  const hover = useRef<{ id?: string; timer?: ReturnType<typeof setTimeout> }>({});
  const loadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [parsed, setParsed] = useState<ParsedImport>(); const [targetId, setTargetId] = useState(''); const [draftTitle, setDraftTitle] = useState(''); const [draftUrl, setDraftUrl] = useState('');
  const [rename, setRename] = useState<RenameRule>({ find: '', replace: '', prefix: '', suffix: '', numbering: false, start: 1 });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS); const [checkScope, setCheckScope] = useState('selected'); const [purgeAck, setPurgeAck] = useState(false);
  const nav = useRef<{ back: LocationState[]; forward: LocationState[] }>({ back: [], forward: [] }); const [navVersion, setNavVersion] = useState(0);
  const managerScroll = useRef<LocationState>(defaultExplorer); const dashboardScroll = useRef<LocationState>({ query: '', scrollTop: 0 }); const dashboardSelection = useRef(new Set<string>());
  const pending = useRef(new Map<string, { command: EditCommand; token?: string; view: View }>());

  const refresh = useCallback(async () => { if (!isExtension) { setLoading(false); return; } try { setState(await request<AppState>({ type: 'state' })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); } }, []);
  useEffect(() => {
    void get('kv', 'explorer').then(saved => { const value = saved?.value as Partial<ExplorerState> | undefined; if (value) { const restored = { ...defaultExplorer, folderId: typeof value.folderId === 'string' ? value.folderId : undefined, view: value.view === 'list' ? 'list' as const : 'grid' as const, sort: ['browser', 'name', 'created', 'type'].includes(value.sort ?? '') ? value.sort! : 'browser' as const, ancestors: Array.isArray(value.ancestors) ? value.ancestors.filter(x => typeof x === 'string') : [] }; setExplorer(restored); managerScroll.current = restored; } }).catch(() => {}).finally(() => setPrefsReady(true));
    void refresh(); if (!isExtension) return;
    void request({ type: 'resume' }).catch(e => setError(String(e)));
    const listener = (m: { type: string }) => { if (m.type === 'changed' && !loadTimer.current) loadTimer.current = setTimeout(() => { loadTimer.current = undefined; void refresh(); }, 200); };
    chrome.runtime.onMessage.addListener(listener); return () => { chrome.runtime.onMessage.removeListener(listener); clearTimeout(loadTimer.current); clearTimeout(hover.current.timer); };
  }, [refresh]);
  useEffect(() => { if (prefsReady) void put('kv', { id: 'explorer', value: { folderId, view: explorer.view, sort: explorer.sort, ancestors: explorer.ancestors } }).catch(() => {}); }, [folderId, explorer.view, explorer.sort, explorer.ancestors, prefsReady]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!context) return; const close = () => setContext(undefined); window.addEventListener('click', close); return () => window.removeEventListener('click', close); }, [context]);
  const records = useMemo(() => flatten(state.tree, state.metadata), [state.tree, state.metadata]);
  const map = useMemo(() => new Map(records.map(n => [n.id, n])), [records]);
  const results = useMemo(() => { const m = new Map<string, CheckResult>(); for (const r of state.results) if ((m.get(r.nodeId)?.checkedAt ?? 0) <= r.checkedAt) m.set(r.nodeId, r); return m; }, [state.results]);
  const folder = map.get(folderId ?? ''); const selectedNodes = records.filter(n => selected.has(n.id));
  const metadataMap = useMemo(() => new Map(state.metadata.map(m => [m.id, m])), [state.metadata]);
  const selectedDescendants = useMemo(() => { const ids = new Set<string>(); const queue = [...selected]; while (queue.length) { const n = map.get(queue.pop()!); if (!n || ids.has(n.id)) continue; ids.add(n.id); queue.push(...n.children); } return ids; }, [selected, map]);
  const mutable = selectedNodes.length > 0 && selectedNodes.every(n => !n.readOnly && !n.fixed && !metadataMap.get(n.id)?.recycleRegion);
  const folders = records.filter(n => n.url === undefined && n.parentId && !n.readOnly && !n.inTrash);
  const ordinary = records.filter(n => !n.inTrash && n.url !== undefined);
  const trashRoots = new Set(state.metadata.filter(m => m.recycleRegion).map(m => m.id));
  const deleted = records.filter(n => n.inTrash && n.parentId && trashRoots.has(n.parentId));
  const managerRows = useMemo(() => explorerRows(records, folderId, search, explorer.sort), [records, folderId, search, explorer.sort]);
  const boardRows = useMemo(() => dashboardRows(records, results, deferredFilter), [records, results, deferredFilter]);
  const rows = view === 'library' ? managerRows : view === 'dashboard' ? boardRows : deleted;
  const grid = view === 'library' && explorer.view === 'grid';
  const runningOp = state.operations.find(o => ['queued', 'running', 'needs-review'].includes(o.status));
  const activeJob = state.jobs.find(j => ['queued', 'running'].includes(j.status));
  const canInsert = view === 'library' && !query.trim() && explorer.sort === 'browser';
  const operationBusy = busy || !!runningOp;

  useEffect(() => {
    if (loading || !prefsReady) return;
    const valid = validFolder(folderId, explorer.ancestors, map);
    const ancestors = ancestorIds(valid, map);
    if (valid !== folderId) { setExplorer(s => ({ ...s, folderId: valid, ancestors, query: '', scrollTop: 0, firstVisibleId: undefined })); managerScroll.current = { folderId: valid, query: '', scrollTop: 0 }; setSelected(new Set()); setNavVersion(v => v + 1); }
    else if (ancestors.join('/') !== explorer.ancestors.join('/')) setExplorer(s => ({ ...s, ancestors }));
    setSelected(s => { const next = new Set([...s].filter(id => map.has(id))); return next.size === s.size ? s : next; });
  }, [map, loading, prefsReady, folderId]);
  useEffect(() => {
    for (const [id, info] of pending.current) {
      const op = state.operations.find(o => o.id === id); if (!op || ['queued', 'running'].includes(op.status)) continue;
      if (info.token) setClipboard(c => finishCut(c, op, info.token!));
      if (op.status === 'needs-review') { setToast('操作需要核对，请打开“操作与版本”。已完成的移动已更新剪切状态。'); continue; }
      pending.current.delete(id);
      const ids = completedIds(op); const destination = 'parentId' in info.command ? info.command.parentId : undefined;
      if (ids.length && view === info.view && (view !== 'library' || !destination || folderId === destination)) {
        if (['create', 'copy', 'import', 'move'].includes(info.command.kind)) { setSelected(new Set(ids.filter(id => map.has(id)))); const first = ids.find(id => managerRows.some(n => n.id === id)); if (first && ['create', 'copy', 'import'].includes(info.command.kind)) { managerScroll.current = { ...managerScroll.current, firstVisibleId: first, rowOffset: 0 }; setExplorer(s => ({ ...s, firstVisibleId: first, rowOffset: 0 })); setNavVersion(v => v + 1); } }
        if (info.command.kind === 'trash' || info.command.kind === 'restore') setSelected(new Set());
      }
      const failed = op.steps.filter(s => s.state !== 'done').length;
      setToast(op.status === 'done' ? `已完成：${op.label}` : `部分完成：${op.label}，${failed} 步未完成。详情见“操作与版本”。`);
    }
  }, [state.operations, map]);

  const setQuery = (value: string) => {
    if (!query && value) { nav.current.back.push({ ...explorer, ...managerScroll.current, query }); nav.current.forward = []; }
    managerScroll.current = { folderId, query: value, scrollTop: 0 }; setExplorer(s => ({ ...s, query: value, scrollTop: 0, firstVisibleId: undefined })); setSelected(new Set()); setNavVersion(v => v + 1);
  };
  const navigate = (next: View, id?: string, focusId?: string) => {
    setContext(undefined); setRenameId(undefined);
    if (view === 'dashboard') dashboardSelection.current = selected;
    if (next === 'library' && (id !== undefined || focusId || view === 'library')) {
      nav.current.back.push({ ...explorer, ...managerScroll.current, query }); nav.current.forward = [];
      const valid = validFolder(id, ancestorIds(id, map), map); const location = { folderId: valid, query: '', scrollTop: 0, firstVisibleId: focusId };
      managerScroll.current = location; setExplorer(s => ({ ...s, ...location, ancestors: ancestorIds(valid, map) })); setNavVersion(v => v + 1);
    }
    setView(next); setSelected(next === 'dashboard' ? dashboardSelection.current : new Set(focusId ? [focusId] : []));
  };
  const travel = (direction: 'back' | 'forward') => {
    const stack = nav.current[direction]; const next = stack.pop(); if (!next) return;
    nav.current[direction === 'back' ? 'forward' : 'back'].push({ ...explorer, ...managerScroll.current, query });
    const id = validFolder(next.folderId, next.ancestors ?? ancestorIds(next.folderId, map), map); const location = { ...next, folderId: id };
    managerScroll.current = location; setExplorer(s => ({ ...s, ...location, ancestors: ancestorIds(id, map) })); setSelected(new Set()); setNavVersion(v => v + 1);
  };
  const locate = (n: BookmarkRecord) => navigate('library', n.parentId, n.id);
  const run = async (work: () => Promise<unknown>, success?: string, close = true) => { setBusy(true); setError(''); try { await work(); if (close) setDialog(null); if (success) setToast(success); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const edit = (command: EditCommand, close = true, token?: string) => run(async () => {
    const op = command.kind === 'import' ? await importTransfer(command.parentId, command.folderTitle, command.parsed) : await request<OperationRecord>({ type: 'edit', command });
    pending.current.set(op.id, { command, token, view }); setToast(`已提交：${op.label}。等待后台完成。`);
  }, undefined, close);
  const openDialog = (next: Dialog) => { document.querySelectorAll<HTMLDetailsElement>('.toolbar-menu[open]').forEach(el => { el.open = false; }); setContext(undefined); setError(''); setDialog(next); setTargetId(folder && !folder.inTrash && !folder.readOnly ? folder.id : folders[0]?.id ?? ''); setDraftTitle(next === 'new-folder' ? '新建文件夹' : next === 'snapshot' ? '手动备份' : ''); setDraftUrl(''); setParsed(undefined); setSettings(state.settings); setCheckScope(selectedNodes.length ? 'selected' : (view === 'dashboard' ? filter.folderId : folderId) ? 'current' : 'all'); setPurgeAck(false); };
  const renameSelection = () => { document.querySelectorAll<HTMLDetailsElement>('.toolbar-menu[open]').forEach(el => { el.open = false; }); if (!mutable) return; if (selectedNodes.length === 1 && view !== 'trash') setRenameId(selectedNodes[0].id); else openDialog('rename'); };
  const select = (n: BookmarkRecord, e: MouseEvent, checkbox = false) => {
    if (e.shiftKey && anchor.current) { const a = rows.findIndex(r => r.id === anchor.current); const b = rows.findIndex(r => r.id === n.id); if (a >= 0 && b >= 0) { setSelected(new Set([...(e.ctrlKey || e.metaKey ? selected : []), ...rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(r => r.id)])); return; } }
    setSelected(prev => { if (checkbox || e.metaKey || e.ctrlKey) { const next = new Set(prev); next.has(n.id) ? next.delete(n.id) : next.add(n.id); return next; } return new Set([n.id]); }); anchor.current = n.id;
  };
  const openNode = (n: BookmarkRecord) => { if (n.url === undefined) { if (n.inTrash) setToast('请先恢复此文件夹。'); else navigate('library', n.id); } else { try { if (!['http:', 'https:', 'ftp:', 'file:'].includes(new URL(n.url).protocol)) { setToast('请使用“复制网址”后在浏览器打开。'); return; } window.open(n.url, '_blank', 'noopener,noreferrer'); } catch { setError('URL 无效'); } } };
  const copySelection = (kind: 'cut' | 'copy') => { if (!mutable || selectedNodes.some(n => n.inTrash)) return; setClipboard({ kind, nodes: minimalSelection(selectedNodes.map(expected), records), token: crypto.randomUUID() }); setToast(kind === 'cut' ? '已剪切，进入目标目录后粘贴；Esc 取消。' : '已复制，可跨目录粘贴。'); };
  const paste = () => { document.querySelectorAll<HTMLDetailsElement>('.toolbar-menu[open]').forEach(el => { el.open = false; });
    if (!clipboard || !folderId || operationBusy) return;
    if (!validDrop({ parentId: folderId }, clipboard.nodes.map(n => n.id), map)) { setError('目标不可写，或来源已删除，或目标是来源及其子目录。'); return; }
    void edit({ kind: clipboard.kind === 'cut' ? 'move' : 'copy', parentId: folderId, nodes: clipboard.nodes }, false, clipboard.kind === 'cut' ? clipboard.token : undefined);
  };
  const endDrag = () => { dragging.current = []; setDragIds([]); clearTimeout(hover.current.timer); hover.current = {}; };
  const drag: DragController = {
    ids: dragIds,
    start: (n, e) => { if (operationBusy || pending.current.size) { e.preventDefault(); return; } const nodes = minimalSelection((selected.has(n.id) ? selectedNodes : [n]).map(expected), records); const ids = nodes.map(n => n.id); dragging.current = ids; setDragIds(ids); e.dataTransfer.setData('application/x-bookmarker', JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'move'; },
    end: endDrag,
    canDrop: (intent, e) => e.dataTransfer.types.includes('application/x-bookmarker') && !operationBusy && validDrop(intent, dragging.current, map),
    drop: (intent, e) => { if (e.dataTransfer.types.includes('application/x-bookmarker') && !operationBusy && validDrop(intent, dragging.current, map)) void edit({ kind: 'move', nodes: dragging.current.map(id => expected(map.get(id)!)), ...intent }, false); endDrag(); },
    hover: id => { if (hover.current.id === id) return; clearTimeout(hover.current.timer); hover.current = { id }; if (id) hover.current.timer = setTimeout(() => { if (dragging.current.length && validDrop({ parentId: id }, dragging.current, map)) navigate('library', id); }, 600); },
  };
  const scopeFolderId = view === 'dashboard' ? filter.folderId : folderId;
  const scopeIds = (s: string) => { if (s === 'selected') return [...selectedDescendants]; if (s === 'current' && scopeFolderId) return [...descendants(scopeFolderId, records)]; if (s === 'retry') return boardRows.filter(n => { const r = results.get(n.id); return n.url !== undefined && r && r.status !== 'ok' && r.status !== 'skipped'; }).map(n => n.id); return ordinary.map(n => n.id); };
  const startCheck = async () => {
    setError(''); setBusy(true);
    try { const granted = await chrome.permissions.request(CHECK_PERMISSIONS); await request({ type: 'check', nodeIds: scopeIds(checkScope), scope: ({ selected: '选中项目', current: '指定目录', all: '全部书签', retry: '筛选范围失败项重测' })[checkScope] ?? checkScope }); setToast(granted ? '检测已开始，后台会保存进度。' : '未获得检测权限，任务会记录为已跳过。'); setDialog(null); if (view !== 'dashboard') navigate('dashboard'); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const contextAt = (e: MouseEvent, node?: BookmarkRecord) => { e.preventDefault(); if (node && !selected.has(node.id)) setSelected(new Set([node.id])); if (!node) setSelected(new Set()); setContext({ x: Math.min(e.clientX, window.innerWidth - 235), y: Math.max(8, Math.min(e.clientY, window.innerHeight - 460)), node }); };
  const cutIds = useMemo(() => { const ids = new Set<string>(); const queue = clipboard?.kind === 'cut' ? clipboard.nodes.map(n => n.id) : []; while (queue.length) { const id = queue.pop()!; const n = map.get(id); if (!n || ids.has(id)) continue; ids.add(id); queue.push(...n.children); } return ids; }, [clipboard, map]);
  const pathIds = ancestorIds(query && selectedNodes.length === 1 ? selectedNodes[0].parentId : folderId, map);
  const details = <Details key={selectedNodes.map(n => n.id).join(',')} nodes={selectedNodes} results={results} metadata={state.metadata} edit={edit} busy={operationBusy} onLocate={locate} onMove={() => openDialog('move')} onRename={() => openDialog('rename')}/>;

  useEffect(() => { const close = (e: globalThis.MouseEvent) => { document.querySelectorAll<HTMLDetailsElement>('.toolbar-menu[open]').forEach(el => { if (!el.contains(e.target as Node)) el.open = false; }); }; window.addEventListener('click', close); return () => window.removeEventListener('click', close); }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement; if (target.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (e.key === 'Escape') { setContext(undefined); setRenameId(undefined); if (!dialog) { setClipboard(undefined); setSelected(new Set()); endDrag(); } return; }
      if (dialog) return; const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); document.querySelector<HTMLInputElement>(view === 'dashboard' ? '[aria-label="高级搜索"]' : '[aria-label="搜索书签"]')?.focus(); }
      if (view === 'history') return;
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelected(new Set(rows.map(n => n.id))); }
      if (mod && ['x', 'c'].includes(e.key.toLowerCase())) { e.preventDefault(); copySelection(e.key.toLowerCase() === 'x' ? 'cut' : 'copy'); }
      if (mod && e.key.toLowerCase() === 'v' && view === 'library') { e.preventDefault(); paste(); }
      if (e.key === 'F2') { e.preventDefault(); renameSelection(); }
      if (e.key === 'Delete' && mutable && view !== 'trash' && !operationBusy) { e.preventDefault(); void edit({ kind: 'trash', nodes: selectedNodes.map(expected) }); }
      if (e.key === 'Enter' && selectedNodes.length === 1) openNode(selectedNodes[0]);
      if (view === 'library' && e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); travel('back'); }
      if (view === 'library' && e.altKey && e.key === 'ArrowRight') { e.preventDefault(); travel('forward'); }
      if (view === 'library' && (e.altKey || mod) && e.key === 'ArrowUp' && folderId) { e.preventDefault(); navigate('library', map.get(folder?.parentId ?? '')?.parentId ? folder?.parentId : undefined); }
    }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  });

  return <div className="app-shell finder-shell">
    <aside className="sidebar"><a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('library'); }}><Bookmark size={22}/><span>BookMarker</span></a>
      <nav className="main-nav">{([['library', BookOpen], ['dashboard', CheckCheck]] as const).map(([key, Icon]) => <button key={key} className={view === key ? 'active' : ''} onClick={() => navigate(key)}><Icon size={18}/><span>{viewLabels[key]}</span></button>)}</nav>
      <div className="section-label">文件夹</div><div className="tree-scroll"><DirectoryTree records={records} current={view === 'library' ? folderId : undefined} navigate={id => navigate('library', id)} drag={drag}/></div>
      <nav className="bottom-nav"><button className={view === 'trash' ? 'active' : ''} onClick={() => navigate('trash')}><Trash2 size={18}/><span>回收站</span><b>{deleted.length || ''}</b></button><button className={view === 'history' ? 'active' : ''} onClick={() => navigate('history')}><History size={18}/><span>操作与版本</span>{runningOp && <i className="sync-dot"/>}</button><button onClick={() => openDialog('settings')}><Settings2 size={18}/><span>设置</span></button></nav>
      <div className="workspace-title">{isExtension ? '浏览器书签已连接' : '扩展安装预览'}</div>
    </aside>
    <main className="main"><header className="topbar">
      {view === 'library' && <div className="navigation-buttons"><button aria-label="后退" disabled={!nav.current.back.length} onClick={() => travel('back')}><ArrowLeft size={18}/></button><button aria-label="前进" disabled={!nav.current.forward.length} onClick={() => travel('forward')}><ArrowRight size={18}/></button><button aria-label="上一级" disabled={!folderId} onClick={() => navigate('library', map.get(folder?.parentId ?? '')?.parentId ? folder?.parentId : undefined)}><ArrowUp size={18}/></button></div>}
      <strong className="directory-title">{view === 'library' ? folder?.title || '浏览器顶层目录' : viewLabels[view]}</strong>
      {view === 'library' && <label className="search-input"><Search size={17}/><input aria-label="搜索书签" placeholder="搜索当前目录及子目录" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button aria-label="清除搜索" onClick={() => setQuery('')}><X size={14}/></button>}</label>}
      {view === 'library' && <><details className="toolbar-menu"><summary><Plus size={17}/>新建</summary><div><button onClick={() => openDialog('new-folder')} disabled={!isExtension}>新建文件夹</button><button onClick={() => openDialog('new-bookmark')} disabled={!isExtension}>新建书签</button></div></details><details className="toolbar-menu"><summary><Ellipsis size={18}/>整理工具</summary><div><button disabled={!mutable} onClick={renameSelection}>重命名</button><button disabled={!mutable} onClick={() => openDialog('move')}>移动到文件夹</button><button disabled={!clipboard || !folderId || operationBusy} onClick={paste}>粘贴</button><hr/><label>显示排序<select aria-label="显示排序" value={explorer.sort} onChange={e => setExplorer(s => ({ ...s, sort: e.target.value as ExplorerState['sort'] }))}><option value="browser">浏览器原始顺序</option><option value="name">名称</option><option value="created">创建时间</option><option value="type">类型</option></select></label><button disabled={!folderId || !!query || explorer.sort === 'browser' || rows.some(n => n.fixed || n.readOnly) || !rows.length || operationBusy} onClick={() => void edit({ kind: 'move', parentId: folderId!, index: 0, nodes: rows.map(expected) }, false)}>将当前排序应用到浏览器</button><hr/><button onClick={() => openDialog('import')}>导入</button><button onClick={() => openDialog('export')}>导出与备份</button><button onClick={() => void refresh()}>刷新</button><button onClick={() => openDialog('help')}>帮助</button></div></details><div className="view-toggle"><button className={grid ? 'active' : ''} aria-label="图标视图" aria-pressed={grid} onClick={() => setExplorer(s => ({ ...s, ...managerScroll.current, view: 'grid' }))}><LayoutGrid size={18}/></button><button className={!grid ? 'active' : ''} aria-label="列表视图" aria-pressed={!grid} onClick={() => setExplorer(s => ({ ...s, ...managerScroll.current, view: 'list' }))}><List size={18}/></button></div></>}
      {view === 'history' && <button onClick={() => openDialog('snapshot')}><Archive size={16}/>创建快照</button>}{view === 'trash' && <button className="danger" disabled={!deleted.length || operationBusy} onClick={() => { setSelected(new Set(deleted.map(n => n.id))); openDialog('purge'); }}>清空回收站</button>}
    </header>
    {!isExtension && <div className="install-banner">请在 Chrome / Edge 中加载 dist 扩展目录后使用。</div>}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭错误" onClick={() => setError('')}><X size={16}/></button></div>}
    {view === 'dashboard' && <DashboardControls records={records} rows={boardRows} results={results} filter={filter} setFilter={f => { setFilter(f); dashboardScroll.current = { query: '', scrollTop: 0 }; setSelected(new Set()); }} onCheck={() => openDialog('check')} onLocate={locate} edit={edit} busy={operationBusy}/>}
    {activeJob && <div className="progress-strip"><LoaderCircle className="spin" size={16}/><span>正在检测 · {activeJob.scope} · {activeJob.items.filter(i => i.state === 'done').length} / {activeJob.items.length}</span><progress value={activeJob.items.filter(i => i.state === 'done').length} max={activeJob.items.length}/><button onClick={() => void run(() => request({ type: 'cancel-check', jobId: activeJob.id }), '已取消检测', false)}>取消检测</button></div>}
    {runningOp && <div className="progress-strip"><History size={16}/><span>{runningOp.status === 'needs-review' ? '操作需要核对' : runningOp.label} · {runningOp.steps.filter(s => s.state === 'done').length} / {runningOp.steps.length}</span><button onClick={() => navigate('history')}>查看进度</button></div>}
    {view === 'history' ? <HistoryView state={state} run={run} edit={edit}/> : <div className={`explorer ${view === 'dashboard' ? 'dashboard-explorer' : ''}`}><section className="list-panel">
      {!grid && <div className={`table-head ${view === 'dashboard' ? 'dashboard-head' : ''}`}><input type="checkbox" aria-label="全选当前列表" checked={rows.length > 0 && rows.every(n => selected.has(n.id))} onChange={e => setSelected(new Set(e.target.checked ? rows.map(n => n.id) : []))}/><span>名称</span><span>网址</span><span>创建时间</span><span>类型</span>{view === 'dashboard' && <><span>链接状态</span><span>定位</span></>}</div>}
      <ExplorerItems rows={rows} grid={grid} dashboard={view === 'dashboard'} selected={selected} cut={cutIds} results={results} location={view === 'library' ? { ...explorer, ...managerScroll.current } : view === 'dashboard' ? dashboardScroll.current : { query: '', scrollTop: 0 }} locationKey={view === 'library' ? `${view}-${navVersion}` : view === 'dashboard' ? `${view}-${JSON.stringify(filter)}` : view} onScroll={(scrollTop, firstVisibleId, rowOffset) => { if (view === 'library') managerScroll.current = { folderId, query, scrollTop, firstVisibleId, rowOffset }; else if (view === 'dashboard') dashboardScroll.current = { query: '', scrollTop, firstVisibleId, rowOffset }; }} select={select} setSelected={setSelected} open={openNode} context={contextAt} drag={drag} canInsert={canInsert} renameId={renameId} rename={(n, title) => { setRenameId(undefined); if (title !== undefined && title !== n.title) void edit({ kind: 'update', changes: [{ expected: expected(n), title }] }, false); }} locate={locate}/>
      <div className="selection-actions"><span>{rows.length.toLocaleString()} 个项目{selected.size > 0 && ` · 已选择 ${selected.size} 项`}{loading && ' · 正在读取…'}</span>{selected.size > 0 && <div>{view === 'trash' ? <><button disabled={!mutable || operationBusy} onClick={() => void edit({ kind: 'restore', nodes: selectedNodes.map(expected) })}>恢复</button><button disabled={!mutable} onClick={() => openDialog('purge')}>永久删除</button></> : <><button disabled={!mutable || operationBusy} onClick={renameSelection}>重命名</button><button disabled={!mutable} onClick={() => openDialog('move')}>移动</button><button disabled={!mutable || operationBusy} onClick={() => void edit({ kind: 'trash', nodes: selectedNodes.map(expected) })}>回收</button></>}<button aria-label="取消选择" onClick={() => setSelected(new Set())}><X size={14}/></button></div>}</div>
    </section>{!grid && details}</div>}
    {view === 'library' && <footer className="path-bar"><button onClick={() => navigate('library')}><BookOpen size={15}/>浏览器</button>{pathIds.map(id => <span key={id}><ChevronRight size={12}/><button onClick={() => navigate('library', id)} onDragOver={e => { if (drag.canDrop({ parentId: id }, e)) { e.preventDefault(); drag.hover(id); } }} onDragLeave={() => drag.hover()} onDrop={e => { e.preventDefault(); e.stopPropagation(); drag.drop({ parentId: id }, e); }}><Folder size={14}/>{map.get(id)?.title}</button></span>)}{query && selectedNodes.length === 1 && <span><ChevronRight size={12}/>{selectedNodes[0].title}</span>}</footer>}
    </main>
    {context && <div className="context-menu" role="menu" style={{ left: context.x, top: context.y }}>{context.node ? <><button onClick={() => openNode(context.node!)}>打开</button><button onClick={() => locate(context.node!)}>在书签管理器中显示</button><hr/>{context.node.inTrash ? <><button disabled={!mutable} onClick={() => void edit({ kind: 'restore', nodes: selectedNodes.map(expected) })}>恢复</button><button disabled={!mutable} onClick={() => openDialog('purge')}>永久删除…</button></> : <><button disabled={!mutable} onClick={() => copySelection('cut')}><Scissors size={15}/>剪切</button><button disabled={!mutable} onClick={() => copySelection('copy')}><Copy size={15}/>复制</button><button disabled={!context.node.url} onClick={() => { void navigator.clipboard.writeText(context.node!.url!).catch(e => setError(String(e))); }}>复制网址</button><button disabled={!mutable} onClick={() => openDialog('move')}>移动到…</button><button disabled={!mutable} onClick={renameSelection}>重命名</button><button disabled={!mutable || operationBusy} onClick={() => void edit({ kind: 'trash', nodes: selectedNodes.map(expected) })}>移入回收站</button></>}<hr/><button onClick={() => openDialog('properties')}>显示属性</button></> : <><button onClick={() => openDialog('new-folder')}>新建文件夹</button><button onClick={() => openDialog('new-bookmark')}>新建书签</button><button disabled={!clipboard || !folderId || operationBusy || view !== 'library'} onClick={paste}>粘贴</button><button onClick={() => setSelected(new Set(rows.map(n => n.id)))}>全选</button>{view === 'library' && <><hr/>{(['browser', 'name', 'created', 'type'] as const).map((s, i) => <button key={s} onClick={() => setExplorer(e => ({ ...e, sort: s }))}>{['浏览器原始顺序', '按名称显示', '按创建时间显示', '按类型显示'][i]}{explorer.sort === s && <Check size={14}/>}</button>)}<hr/><button onClick={() => setExplorer(s => ({ ...s, ...managerScroll.current, view: 'grid' }))}>图标视图</button><button onClick={() => setExplorer(s => ({ ...s, ...managerScroll.current, view: 'list' }))}>列表视图</button></>}</>}</div>}
    {toast && <div className="toast" role="status"><Check size={17}/><span>{toast}</span><button onClick={() => setToast('')} aria-label="关闭提示"><X size={14}/></button></div>}
    {dialog && <Modal title={dialogTitles[dialog]} onClose={() => !busy && setDialog(null)} wide={['rename', 'import', 'help'].includes(dialog)}>
      {dialog === 'properties' && details}
      {error && <div className="modal-error" role="alert">{error}</div>}
      {(dialog === 'new-bookmark' || dialog === 'new-folder') && <form onSubmit={e => { e.preventDefault(); void edit({ kind: 'create', parentId: targetId, title: draftTitle, ...(dialog === 'new-bookmark' ? { url: draftUrl } : {}) }); }}><label>名称<input autoFocus required value={draftTitle} onChange={e => setDraftTitle(e.target.value)} placeholder="给这份收藏起个名字"/></label>{dialog === 'new-bookmark' && <label>网址<input type="url" required value={draftUrl} onChange={e => setDraftUrl(e.target.value)} placeholder="https://"/></label>}<FolderSelect folders={folders} value={targetId} setValue={setTargetId}/><Notice>保存后立即写入当前浏览器。URL 以浏览器实际保存的值为准。</Notice><div className="modal-actions"><button type="button" onClick={() => setDialog(null)}>取消</button><button className="primary" disabled={busy || !targetId}>{busy ? '提交中…' : '创建'}</button></div></form>}
      {dialog === 'move' && <form onSubmit={e => { e.preventDefault(); void edit({ kind: 'move', nodes: selectedNodes.map(expected), parentId: targetId }); }}><p className="modal-lead">将选中的 {selectedNodes.length} 项移动到：</p><FolderSelect folders={folders.filter(n => !selectedDescendants.has(n.id))} value={targetId} setValue={setTargetId}/><div className="modal-actions"><button type="button" onClick={() => setDialog(null)}>取消</button><button className="primary" disabled={busy || !targetId}>移动</button></div></form>}
      {dialog === 'rename' && <form onSubmit={e => { e.preventDefault(); void edit({ kind: 'update', changes: renamePreview(selectedNodes, rename) }); }}><div className="form-grid"><label>查找文字<input value={rename.find} onChange={e => setRename({ ...rename, find: e.target.value })}/></label><label>替换为<input value={rename.replace} onChange={e => setRename({ ...rename, replace: e.target.value })}/></label><label>前缀<input value={rename.prefix} onChange={e => setRename({ ...rename, prefix: e.target.value })}/></label><label>后缀<input value={rename.suffix} onChange={e => setRename({ ...rename, suffix: e.target.value })}/></label></div><label className="checkbox-label"><input type="checkbox" checked={rename.numbering} onChange={e => setRename({ ...rename, numbering: e.target.checked })}/>添加连续编号<input aria-label="起始编号" className="number-input" type="number" value={rename.start} min={0} onChange={e => setRename({ ...rename, start: Number(e.target.value) })}/></label><div className="preview-table"><header><span>原名称</span><span>修改后预览</span></header>{renamePreview(selectedNodes, rename).map(c => <div key={c.expected.id}><span>{c.expected.title}</span><strong>{c.title || '（空标题）'}</strong></div>)}</div><div className="modal-actions"><span>共 {selectedNodes.length} 项 · 提交后立即生效</span><button className="primary" disabled={busy || !selectedNodes.length}>应用重命名</button></div></form>}
      {dialog === 'import' && <><label className="upload-zone"><Upload size={28}/><strong>{parsed ? parsed.source.name : '选择书签文件或项目备份'}</strong><span>HTML · Chromium Bookmarks · Firefox JSON · 项目 ZIP</span><input aria-label="导入文件" type="file" accept=".html,.htm,.json,.zip,application/json,text/html,application/zip" disabled={busy} onChange={e => { const f = e.target.files?.[0]; if (f) void run(async () => { const p = await parseFile(f.name, new Uint8Array(await f.arrayBuffer())); setParsed(p); setDraftTitle(`导入 · ${f.name.replace(/\.[^.]+$/, '')}`); }, undefined, false); }}/></label>{parsed && <><div className="import-summary"><span><strong>{importStats(parsed.nodes).bookmarks.toLocaleString()}</strong> 个书签</span><span><strong>{importStats(parsed.nodes).folders.toLocaleString()}</strong> 个目录</span><span>{parsed.format}</span></div><div className="import-tree">{parsed.nodes.slice(0, 30).map(n => <div key={n.key}>{n.url === undefined ? <Folder size={15}/> : <Globe size={15}/>}<span>{n.title || '未命名'}</span><small>{n.url ?? `${n.children?.length ?? 0} 个直接子项`}</small></div>)}{parsed.nodes.length > 30 && <small>另有 {parsed.nodes.length - 30} 个顶层项目</small>}</div><FolderSelect folders={folders} value={targetId} setValue={setTargetId}/><label>新建导入文件夹<input required value={draftTitle} onChange={e => setDraftTitle(e.target.value)}/></label><Notice>{parsed.warnings.map((w, i) => <p key={i}>{w}</p>)}<small className="hash">SHA-256 · {parsed.source.sha256}</small></Notice></>}<div className="modal-actions"><button onClick={() => setDialog(null)}>取消</button><button className="primary" disabled={busy || !parsed || !targetId || !draftTitle} onClick={() => parsed && void edit({ kind: 'import', parentId: targetId, folderTitle: draftTitle, parsed })}>{busy ? '解析中…' : '确认导入'}</button></div></>}
      {dialog === 'export' && <div className="export-options"><button onClick={() => { download(exportHtml(state.tree, state.metadata), `BookMarker-${new Date().toISOString().slice(0, 10)}.html`, 'text/html;charset=utf-8'); setToast('HTML 已生成，下载由浏览器处理'); setDialog(null); }}><Globe size={24}/><span><strong>通用书签 HTML</strong><small>UTF-8 · 可导入 Chrome / Edge / Firefox · 排除回收站</small></span><Download size={18}/></button><button disabled={busy} onClick={() => void run(async () => { const data = await backupTransfer(); download(encodeBackup(data), `BookMarker-project-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip'); }, '完整项目 ZIP 已生成')}><Archive size={24}/><span><strong>完整项目备份 ZIP</strong><small>书签、原文件、扩展元数据、历史、快照和检测结果</small></span>{busy ? <LoaderCircle className="spin" size={18}/> : <Download size={18}/>}</button><Notice>浏览器 API 未公开的元数据无法读取。卸载扩展会清除扩展内备份，下载的 ZIP 可以独立保留。</Notice></div>}
      {dialog === 'settings' && <form onSubmit={e => { e.preventDefault(); void run(() => request({ type: 'settings', settings }), '设置已保存'); }}><label className="checkbox-label"><input type="checkbox" checked={settings.allowPrivate} onChange={e => setSettings({ ...settings, allowPrivate: e.target.checked })}/>允许检测内网与本机地址</label><Notice>默认跳过明确的内网 IP、本机和已知内网域名。纯扩展无法提前识别所有域名的内网解析结果，此筛选不是严格的网络隔离。</Notice><div className="form-grid"><label>总并发（1–12）<input type="number" min={1} max={12} value={settings.concurrency} onChange={e => setSettings({ ...settings, concurrency: Number(e.target.value) })}/></label><label>同主机并发（1–2）<input type="number" min={1} max={2} value={settings.perHost} onChange={e => setSettings({ ...settings, perHost: Number(e.target.value) })}/></label></div><label>单次尝试超时（毫秒，最多 12000）<input type="number" min={1000} max={12000} step={1000} value={settings.timeoutMs} onChange={e => setSettings({ ...settings, timeoutMs: Number(e.target.value) })}/></label><Notice>请求使用浏览器适用的网络配置，不设置代理、不携带站点登录凭据，不使用云端数据库或 storage.sync。浏览器自身的书签同步由浏览器设置决定。</Notice><div className="modal-actions"><button type="button" onClick={() => setDialog(null)}>取消</button><button className="primary" disabled={busy || !isExtension}>保存设置</button></div></form>}
      {dialog === 'check' && <><p className="modal-lead">检测链接的当前响应，结果不会自动删除任何书签。</p><label>检测范围<select value={checkScope} onChange={e => setCheckScope(e.target.value)}><option value="selected" disabled={!selectedNodes.length}>选中项目（含子目录）</option><option value="current" disabled={!scopeFolderId}>指定目录（含子目录）</option><option value="all">全部书签</option><option value="retry">失败项重测</option></select></label><Notice>首次检测需要网站访问和 webRequest 权限。检测先发起 HEAD，必要时用 GET 复核，最多消费 64 KiB 正文；不携带登录凭据。站点会收到正常网络请求。</Notice><div className="check-facts"><span>并发 <b>{state.settings.concurrency}</b></span><span>同主机 <b>{state.settings.perHost}</b></span><span>单次超时 <b>{state.settings.timeoutMs / 1000}s</b></span><span>内网 <b>{state.settings.allowPrivate ? '允许' : '跳过'}</b></span></div><div className="modal-actions"><button onClick={() => setDialog(null)}>取消</button><button className="primary" disabled={busy || !scopeIds(checkScope).length} onClick={() => void startCheck()}>授权并开始检测</button></div></>}
      {dialog === 'purge' && <><Notice>将永久删除选中的 {selectedNodes.length} 个项目及其子目录。此操作不能通过移动恢复；即使重建，也无法保留原节点 ID、创建时间和未公开元数据。</Notice><label className="checkbox-label"><input type="checkbox" checked={purgeAck} onChange={e => setPurgeAck(e.target.checked)}/>我确认要永久删除这些内容</label><div className="modal-actions"><button onClick={() => setDialog(null)}>保留</button><button className="danger-fill" disabled={busy || !purgeAck || !mutable} onClick={() => void edit({ kind: 'purge', nodes: selectedNodes.map(expected), confirmed: true })}>永久删除</button></div></>}
      {dialog === 'snapshot' && <form onSubmit={e => { e.preventDefault(); void run(() => request({ type: 'snapshot', label: draftTitle }), '快照已创建'); }}><label>版本名称<input autoFocus required value={draftTitle} onChange={e => setDraftTitle(e.target.value)}/></label><Notice>快照保存在本机扩展内。回滚生成新版本，只撤回本工具能够确认的操作；外部修改会保留并显示冲突。</Notice><div className="modal-actions"><button className="primary" disabled={busy}>创建快照</button></div></form>}
      {dialog === 'help' && <div className="help-content"><h3>从浏览器开始，整理每一份收藏</h3><p>BookMarker 使用当前浏览器配置的书签。新建、编辑、移动和排序立即生效；浏览器和其他扩展的变更会同步到此页面。</p><div className="help-grid"><article><Folder size={21}/><h4>像管理文件一样</h4><p>双击打开，勾选或 Cmd/Ctrl 多选，Shift 连选。拖到文件夹移动；图标与列表支持框选、剪切复制粘贴、F2 重命名和拖放。</p></article><article><Trash2 size={21}/><h4>先回收，再决定</h4><p>每个来源书签区域按需建立可见回收站。移动和恢复保留节点 ID，永久删除需要明确确认。</p></article><article><Archive size={21}/><h4>原件完整保留</h4><p>导入文件保存原始字节、SHA-256 和额外元数据。直接从浏览器读取时，仅能备份 API 开放的数据。</p></article><article><ShieldCheck size={21}/><h4>数据留在本地</h4><p>不上传书签、不使用云数据库。浏览器自身的书签同步仍由浏览器设置控制。下载 ZIP 可在卸载后继续保留。</p></article></div><Notice>连接异常和超时无法直接确定责任在本地网络或目标站点。错误原文仅作为证据；没有详情时显示“未提供详细错误”。浏览器关闭后检测停止，重新打开会续跑未完成任务。</Notice><p className="subtle">最低 Chromium 134 · 支持 Chrome 与 Edge · 第一版通过开发者模式加载</p></div>}
    </Modal>}
  </div>;
}

const dialogTitles: Record<Exclude<Dialog, null>, string> = { 'new-bookmark': '新建书签', 'new-folder': '新建文件夹', move: '移动到文件夹', rename: '批量重命名', import: '导入与预览', export: '导出与备份', settings: '工作台设置', check: '检测网页可达性', purge: '永久删除确认', snapshot: '创建版本快照', help: '关于 BookMarker', properties: '显示属性' };
function FolderSelect({ folders, value, setValue }: { folders: BookmarkRecord[]; value: string; setValue: (id: string) => void }) { return <label>目标文件夹<select aria-label="目标文件夹" value={value} onChange={e => setValue(e.target.value)}><option value="" disabled>选择目录</option>{folders.map(n => <option key={n.id} value={n.id}>{[...n.path, n.title].join(' / ')}{n.syncing ? ' · 同步区域' : ''}</option>)}</select></label>; }
