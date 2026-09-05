import { useEffect, useRef, useState, type ReactNode, type MouseEvent, type DragEvent } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Globe, LockKeyhole, X, ExternalLink, FileText, Check, ArrowUpRight } from 'lucide-react';
import { hostname } from '../tree';
import { STATUS_LABELS, type BookmarkRecord, type CheckResult } from '../types';

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); const previous = document.activeElement as HTMLElement; return () => previous?.focus(); }, []);
  return <dialog ref={ref} className={wide ? 'modal wide' : 'modal'} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <header><div><span className="eyebrow">BOOKMARKER</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></header>{children}
  </dialog>;
}
export function Status({ result }: { result?: CheckResult }) { const key = result?.stale ? 'stale' : result?.status ?? 'unchecked'; return <span className={`status ${key}`}><i />{STATUS_LABELS[key]}</span>; }
export function Empty({ title, description, children }: { title: string; description: string; children?: ReactNode }) { return <div className="empty"><div className="empty-symbol"><FolderOpen size={34} strokeWidth={1.3}/></div><h3>{title}</h3><p>{description}</p>{children}</div>; }
export function FolderTree({ records, selected, onSelect, onDrop }: { records: BookmarkRecord[]; selected?: string; onSelect: (id: string) => void; onDrop: (id: string) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const children = new Map<string, BookmarkRecord[]>();
  for (const n of records) if (n.parentId && n.url === undefined && !n.inTrash) children.set(n.parentId, [...children.get(n.parentId) ?? [], n]);
  const roots = records.filter(n => !n.parentId);
  function branch(n: BookmarkRecord, depth: number): ReactNode {
    const folders = children.get(n.id) ?? []; const expanded = open.has(n.id);
    return <div key={n.id}><div className={`folder-branch ${selected === n.id ? 'active' : ''}`} style={{ paddingLeft: 12 + depth * 15 }} onDragOver={e => { if (!n.readOnly) e.preventDefault(); }} onDrop={e => { e.preventDefault(); e.stopPropagation(); onDrop(n.id); }}>
      <button className="tree-chevron" aria-label={`${expanded ? '折叠' : '展开'} ${n.title}`} disabled={!folders.length} onClick={() => setOpen(s => { const next = new Set(s); if (next.has(n.id)) next.delete(n.id); else next.add(n.id); return next; })}>{folders.length ? expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/> : <span/>}</button>
      <button className="tree-label" onClick={() => onSelect(n.id)} title={`${n.title}${n.syncing ? ' · 浏览器账号同步区域' : ''}`}>{n.readOnly ? <LockKeyhole size={15}/> : <Folder size={16}/>}<span>{n.title || '未命名文件夹'}</span>{n.syncing && <i className="sync-dot" title="浏览器账号同步区域"/>}</button>
    </div>{expanded && folders.map(c => branch(c, depth + 1))}</div>;
  }
  return <div className="folder-tree">{roots.flatMap(r => (children.get(r.id) ?? []).map(n => branch(n, 0)))}</div>;
}
export function VirtualList({ rows, selected, results, onSelect, onOpen, onContext, onDrag, onDrop, showPath }: { rows: BookmarkRecord[]; selected: Set<string>; results: Map<string, CheckResult>; onSelect: (n: BookmarkRecord, e: MouseEvent, checkbox?: boolean) => void; onOpen: (n: BookmarkRecord) => void; onContext: (n: BookmarkRecord, e: MouseEvent) => void; onDrag: (n: BookmarkRecord, e: DragEvent) => void; onDrop: (n: BookmarkRecord, e: DragEvent) => void; showPath: boolean }) {
  const viewport = useRef<HTMLDivElement>(null); const [scrollTop, setScrollTop] = useState(0); const [height, setHeight] = useState(600); const rowHeight = 62;
  useEffect(() => { const el = viewport.current; if (!el) return; const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height)); observer.observe(el); return () => observer.disconnect(); }, []);
  useEffect(() => { if (viewport.current) viewport.current.scrollTop = 0; setScrollTop(0); }, [rows.length, showPath]);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 5); const end = Math.min(rows.length, start + Math.ceil(height / rowHeight) + 10);
  return <div className="virtual-list" ref={viewport} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} role="table" aria-label="书签列表" aria-rowcount={rows.length}>
    <div style={{ height: rows.length * rowHeight, position: 'relative' }}>{rows.slice(start, end).map((n, i) => <div key={n.id} role="row" aria-rowindex={start + i + 1} aria-selected={selected.has(n.id)} data-node-id={n.id} className={`bookmark-row ${selected.has(n.id) ? 'selected' : ''}`} style={{ top: (start + i) * rowHeight, height: rowHeight }} onClick={e => onSelect(n, e)} onDoubleClick={() => onOpen(n)} onContextMenu={e => onContext(n, e)} draggable={!n.readOnly && !n.fixed} onDragStart={e => onDrag(n, e)} onDragOver={e => e.preventDefault()} onDrop={e => onDrop(n, e)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen(n); if (e.key === ' ') { e.preventDefault(); onSelect(n, e as unknown as MouseEvent, true); } }}>
      <div className="check-cell"><input type="checkbox" aria-label={`选择 ${n.title}`} checked={selected.has(n.id)} onChange={() => {}} onClick={e => { e.stopPropagation(); onSelect(n, e, true); }}/></div>
      <span className={`item-icon ${n.url === undefined ? 'folder-icon' : ''}`}>{n.url === undefined ? <Folder size={20} fill="currentColor" strokeWidth={1.3}/> : <span>{(hostname(n.url) || n.title || 'B').replace(/^www\./, '')[0]?.toUpperCase()}</span>}</span>
      <div className="item-name"><strong>{n.title || '未命名'}</strong><span>{showPath ? n.path.join(' / ') : n.url ?? `${n.children.length} 个项目`}</span></div>
      <div className="domain-cell">{n.url ? hostname(n.url).replace(/^www\./, '') : '文件夹'}</div>
      <div className="status-cell">{n.url !== undefined ? <Status result={results.get(n.id)}/> : <span className="muted">—</span>}</div>
      <button className="row-open icon-button" title={n.url ? '在新标签页打开' : '打开目录'} onClick={e => { e.stopPropagation(); onOpen(n); }}>{n.url ? <ArrowUpRight size={16}/> : <ChevronRight size={16}/>}</button>
    </div>)}</div>
  </div>;
}
export const formatTime = (date?: number) => date ? new Date(date).toLocaleString('zh-CN', { hour12: false }) : '—';
export function SafeOpen({ url, children }: { url: string; children?: ReactNode }) {
  let safe = false; try { safe = ['http:', 'https:', 'ftp:', 'file:'].includes(new URL(url).protocol); } catch { /* disabled */ }
  return <button disabled={!safe} onClick={() => window.open(url, '_blank', 'noopener,noreferrer')} title={safe ? url : '该地址不支持直接打开，可复制到浏览器使用'}>{children ?? <><ExternalLink size={15}/>打开网页</>}</button>;
}
export function Notice({ children }: { children: ReactNode }) { return <div className="notice"><FileText size={17}/><div>{children}</div></div>; }
export function Done({ children }: { children: ReactNode }) { return <span className="done-inline"><Check size={14}/>{children}</span>; }
