import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { Folder, ChevronRight, ChevronDown, LockKeyhole, Globe } from 'lucide-react';
import type { BookmarkRecord, CheckResult } from '../types';
import { ancestorIds, itemRect, layoutFor, marqueeIds, type DropIntent, type LocationState } from '../explorer';
import { formatTime, Status } from './components';

export interface DragController {
  ids: string[];
  start: (n: BookmarkRecord, e: DragEvent) => void;
  end: () => void;
  canDrop: (intent: DropIntent, e: DragEvent) => boolean;
  drop: (intent: DropIntent, e: DragEvent) => void;
  hover: (id?: string) => void;
}
export function autoScroll(el: HTMLElement, clientY: number) {
  const r = el.getBoundingClientRect(); const distance = 40;
  if (clientY < r.top + distance) el.scrollTop -= Math.max(8, (r.top + distance - clientY) / 2);
  if (clientY > r.bottom - distance) el.scrollTop += Math.max(8, (clientY - r.bottom + distance) / 2);
}
export function DirectoryTree({ records, current, navigate, drag }: { records: BookmarkRecord[]; current?: string; navigate: (id: string) => void; drag: DragController }) {
  const [open, setOpen] = useState(new Set<string>()); const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); const hoverId = useRef<string | undefined>(undefined);
  const map = useMemo(() => new Map(records.map(n => [n.id, n])), [records]);
  const children = useMemo(() => { const m = new Map<string, BookmarkRecord[]>(); for (const n of records) if (n.parentId && n.url === undefined && !n.inTrash) { const a = m.get(n.parentId) ?? []; a.push(n); m.set(n.parentId, a); } return m; }, [records]);
  useEffect(() => { setOpen(s => new Set([...s, ...ancestorIds(current, map).slice(0, -1)])); }, [current, map]);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const clearHover = () => { clearTimeout(hoverTimer.current); hoverId.current = undefined; };
  function branch(n: BookmarkRecord, depth: number): React.ReactNode {
    const expanded = open.has(n.id); const folders = children.get(n.id) ?? [];
    return <div key={n.id}><div data-tree-id={n.id} className={`folder-branch ${current === n.id ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} draggable={!n.fixed && !n.readOnly} onDragStart={e => drag.start(n, e)} onDragEnd={() => { clearHover(); drag.end(); }} onDragOver={e => {
      e.stopPropagation(); const valid = drag.canDrop({ parentId: n.id }, e); e.dataTransfer.dropEffect = valid ? 'move' : 'none';
      if (valid) { e.preventDefault(); if (hoverId.current !== n.id) { clearHover(); hoverId.current = n.id; hoverTimer.current = setTimeout(() => setOpen(s => new Set([...s, n.id])), 600); } }
      const scroll = e.currentTarget.closest('.tree-scroll') as HTMLElement; if (scroll) autoScroll(scroll, e.clientY);
    }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) clearHover(); }} onDrop={e => { e.preventDefault(); e.stopPropagation(); clearHover(); drag.drop({ parentId: n.id }, e); }}>
      <button className="tree-chevron" aria-label={`${expanded ? '折叠' : '展开'} ${n.title}`} disabled={!folders.length} onClick={() => setOpen(s => { const next = new Set(s); expanded ? next.delete(n.id) : next.add(n.id); return next; })}>{expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>
      <button className="tree-label" onClick={() => navigate(n.id)} title={n.title}>{n.readOnly ? <LockKeyhole size={16}/> : <Folder size={17} fill="currentColor"/>}<span>{n.title || '未命名文件夹'}</span></button>
    </div>{expanded && folders.map(c => branch(c, depth + 1))}</div>;
  }
  return <div className="folder-tree">{records.filter(n => !n.parentId).flatMap(n => (children.get(n.id) ?? []).map(c => branch(c, 0)))}</div>;
}
interface Props {
  rows: BookmarkRecord[]; grid: boolean; dashboard?: boolean; selected: Set<string>; cut: Set<string>;
  results: Map<string, CheckResult>; location: LocationState; locationKey: string;
  onScroll: (scrollTop: number, firstVisibleId?: string, rowOffset?: number) => void;
  select: (n: BookmarkRecord, e: MouseEvent, checkbox?: boolean) => void; setSelected: (ids: Set<string>) => void;
  open: (n: BookmarkRecord) => void; context: (e: MouseEvent, n?: BookmarkRecord) => void;
  drag: DragController; canInsert: boolean; renameId?: string; rename: (n: BookmarkRecord, title?: string) => void;
  locate?: (n: BookmarkRecord) => void;
}
export function ExplorerItems(p: Props) {
  const viewport = useRef<HTMLDivElement>(null); const [size, setSize] = useState({ width: 800, height: 600 }); const [scroll, setScroll] = useState(p.location.scrollTop);
  const [indicator, setIndicator] = useState<{ id?: string; edge?: 'before' | 'after'; intent: DropIntent }>();
  const [rect, setRect] = useState<{ x: number; y: number; width: number; height: number }>();
  const marquee = useRef<{ x: number; y: number; base: Set<string>; clientX: number; clientY: number; active: boolean } | undefined>(undefined);
  const layout = layoutFor(size.width, p.grid); const height = Math.max(size.height, Math.ceil(p.rows.length / layout.columns) * layout.rowHeight + layout.inset * 2);
  const latest = useRef({ p, layout }); latest.current = { p, layout };
  useLayoutEffect(() => { const el = viewport.current; if (!el) return; const update = () => setSize({ width: el.clientWidth, height: el.clientHeight }); update(); const ro = new ResizeObserver(update); ro.observe(el); return () => ro.disconnect(); }, [p.grid, p.dashboard]);
  useLayoutEffect(() => {
    const el = viewport.current; if (!el) return;
    const index = p.location.firstVisibleId ? p.rows.findIndex(n => n.id === p.location.firstVisibleId) : -1;
    el.scrollTop = index >= 0 ? Math.floor(index / layout.columns) * layout.rowHeight + Math.min(p.location.rowOffset ?? 0, layout.rowHeight - 1) : p.location.scrollTop; setScroll(el.scrollTop);
  }, [p.locationKey, p.grid, layout.columns]);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const m = marquee.current; const el = viewport.current;
      if (m?.active && el) { autoScroll(el, m.clientY); updateMarquee(m.clientX, m.clientY); }
      frame = requestAnimationFrame(tick);
    };
    if (marquee.current) frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [!!rect]);
  function updateMarquee(clientX: number, clientY: number) {
    const el = viewport.current; const m = marquee.current; if (!el || !m) return;
    m.clientX = clientX; m.clientY = clientY;
    const r = el.getBoundingClientRect(); const x = Math.max(0, Math.min(el.clientWidth, clientX - r.left)); const y = Math.max(0, clientY - r.top + el.scrollTop);
    if (!m.active && Math.abs(x - m.x) + Math.abs(y - m.y) < 4) return;
    m.active = true; const box = { x: Math.min(x, m.x), y: Math.min(y, m.y), width: Math.abs(x - m.x), height: Math.abs(y - m.y) }; setRect(box);
    const { p, layout } = latest.current; p.setSelected(new Set([...m.base, ...marqueeIds(p.rows, layout, box)]));
  }
  function intentAt(n: BookmarkRecord, index: number, e: DragEvent): typeof indicator {
    const r = e.currentTarget.getBoundingClientRect(); const offset = p.grid ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    if (n.url === undefined && (offset > .23 && offset < .77 || !p.canInsert)) return { id: n.id, intent: { parentId: n.id } };
    if (!p.canInsert || !p.location.folderId) return undefined;
    const edge = offset < .5 ? 'before' : 'after';
    const rest = p.rows.slice(index + (edge === 'after' ? 1 : 0)).filter(row => !p.drag.ids.includes(row.id));
    return { id: n.id, edge, intent: { parentId: p.location.folderId, beforeId: rest[0]?.id } };
  }
  const first = Math.max(0, Math.floor((scroll - layout.inset) / layout.rowHeight) - 3) * layout.columns;
  const end = Math.min(p.rows.length, first + (Math.ceil(size.height / layout.rowHeight) + 7) * layout.columns);
  return <div className={`virtual-list ${p.grid ? 'grid-view' : 'list-view'} ${p.dashboard ? 'dashboard-list' : ''}`} ref={viewport} role="grid" aria-label={p.grid ? '书签图标' : '书签列表'} aria-rowcount={Math.ceil(p.rows.length / layout.columns)} tabIndex={0}
    onScroll={e => { const top = e.currentTarget.scrollTop; setScroll(top); const i = Math.floor(top / layout.rowHeight) * layout.columns; p.onScroll(top, p.rows[i]?.id, top % layout.rowHeight); }}
    onContextMenu={e => { if (!(e.target as HTMLElement).closest('[data-node-id]')) p.context(e); }}
    onPointerDown={e => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('[data-node-id]')) return;
      const r = e.currentTarget.getBoundingClientRect(); marquee.current = { x: e.clientX - r.left, y: e.clientY - r.top + e.currentTarget.scrollTop, clientX: e.clientX, clientY: e.clientY, base: e.metaKey || e.ctrlKey ? new Set(p.selected) : new Set(), active: false };
      e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.focus(); if (!e.metaKey && !e.ctrlKey) p.setSelected(new Set());
    }} onPointerMove={e => updateMarquee(e.clientX, e.clientY)} onPointerUp={e => { marquee.current = undefined; setRect(undefined); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { marquee.current = undefined; setRect(undefined); }}
    onDragOver={e => { autoScroll(e.currentTarget, e.clientY); if ((e.target as HTMLElement).closest('[data-node-id]')) return; p.drag.hover(); const intent = p.location.folderId ? { parentId: p.location.folderId } : undefined; if (intent && p.drag.canDrop(intent, e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setIndicator({ intent }); } else { e.dataTransfer.dropEffect = 'none'; setIndicator(undefined); } }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setIndicator(undefined); p.drag.hover(); } }}
    onDrop={e => { e.preventDefault(); if (indicator) p.drag.drop(indicator.intent, e); setIndicator(undefined); }}>
    <div className={`items-canvas ${indicator && !indicator.id ? 'drop-background' : ''}`} style={{ height, position: 'relative' }}>
      {!p.rows.length && <div className="empty-directory">{p.location.query ? '没有找到匹配项' : '此目录为空'}<small>右键新建或粘贴，也可以将项目拖到这里</small></div>}
      {p.rows.slice(first, end).map((n, local) => { const index = first + local; const r = itemRect(index, layout); return <div key={n.id} role="row" aria-rowindex={Math.floor(index / layout.columns) + 1} aria-selected={p.selected.has(n.id)} data-node-id={n.id} tabIndex={-1}
        className={`bookmark-row ${p.grid ? 'bookmark-tile' : ''} ${p.selected.has(n.id) ? 'selected' : ''} ${p.cut.has(n.id) ? 'cut' : ''} ${indicator?.id === n.id ? indicator.edge ? `insert-${indicator.edge}` : 'drop-folder' : ''}`}
        style={{ left: r.x, top: r.y, width: p.grid ? r.width : '100%', height: r.height }} title={n.title}
        onClick={e => { if (!(e.target as HTMLElement).closest('input')) p.select(n, e); }} onDoubleClick={e => { if (!(e.target as HTMLElement).closest('input')) p.open(n); }} onContextMenu={e => { e.stopPropagation(); p.context(e, n); }}
        draggable={!n.fixed && !n.readOnly && !n.inTrash && p.renameId !== n.id} onDragStart={e => p.drag.start(n, e)} onDragEnd={() => { setIndicator(undefined); p.drag.end(); }}
        onDragOver={e => { e.stopPropagation(); autoScroll(viewport.current!, e.clientY); const next = intentAt(n, index, e); if (next && p.drag.canDrop(next.intent, e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setIndicator(next); p.drag.hover(next.edge ? undefined : n.id); } else { e.dataTransfer.dropEffect = 'none'; setIndicator(undefined); p.drag.hover(); } }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { p.drag.hover(); setIndicator(undefined); } }}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); const next = intentAt(n, index, e); if (next) p.drag.drop(next.intent, e); setIndicator(undefined); }}>
        {!p.grid && <div className="check-cell"><input type="checkbox" aria-label={`选择 ${n.title}`} checked={p.selected.has(n.id)} onChange={() => {}} onClick={e => { e.stopPropagation(); p.select(n, e, true); }}/></div>}
        <span className={`item-icon ${n.url === undefined ? 'folder-icon' : ''}`}>{n.url === undefined ? <Folder fill="currentColor" strokeWidth={1.2}/> : <Globe strokeWidth={1.4}/>}</span>
        <div className="item-name">{p.renameId === n.id ? <input aria-label="就地重命名" autoFocus defaultValue={n.title} onFocus={e => e.target.select()} onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); p.rename(n, e.currentTarget.value); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.rename(n); } }} onBlur={() => p.rename(n)}/> : <strong>{n.title || '未命名'}</strong>}</div>
        {!p.grid && <><span className="url-cell" title={n.url ?? n.path.join(' / ')}>{n.url ?? '—'}</span><span className="date-cell">{formatTime(n.dateAdded)}</span><span className="type-cell">{n.url === undefined ? '文件夹' : '书签'}</span>{p.dashboard && <><span className="status-cell">{n.url !== undefined && <Status result={p.results.get(n.id)}/>}</span><button className="locate-button" onClick={e => { e.stopPropagation(); p.locate?.(n); }}>在书签管理器中显示</button></>}</>}
      </div>; })}
      {rect && <div className="marquee" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}/ >}
    </div>
  </div>;
}
