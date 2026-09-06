import { useMemo, useState } from 'react';
import { Bookmark, CheckCheck, Copy, Link2 } from 'lucide-react';
import { duplicates, expected } from '../tree';
import { defaultFilter, statusOf, type DashboardFilter } from '../explorer';
import { STATUS_LABELS, type BookmarkRecord, type CheckResult, type EditCommand } from '../types';
import { Modal } from './components';

export function DashboardControls({ records, rows, results, filter, setFilter, onCheck, onLocate, edit, busy }: {
  records: BookmarkRecord[]; rows: BookmarkRecord[]; results: Map<string, CheckResult>; filter: DashboardFilter;
  setFilter: (f: DashboardFilter) => void; onCheck: () => void; onLocate: (n: BookmarkRecord) => void;
  edit: (c: EditCommand, close?: boolean) => Promise<void>; busy: boolean;
}) {
  const [preview, setPreview] = useState<BookmarkRecord[][]>(); const [keepers, setKeepers] = useState<Record<string, string>>({});
  const ordinary = records.filter(n => n.url !== undefined && !n.inTrash);
  const metrics = [
    { label: '书签总量', value: ordinary.length, icon: Bookmark, f: { type: 'bookmark' } },
    { label: '检测覆盖', value: ordinary.filter(n => !['unchecked', 'stale'].includes(statusOf(results.get(n.id)))).length, icon: CheckCheck, f: { type: 'bookmark', status: 'checked' } },
    { label: '异常数量', value: ordinary.filter(n => !['unchecked', 'stale', 'ok', 'skipped'].includes(statusOf(results.get(n.id)))).length, icon: Link2, f: { type: 'bookmark', status: 'issues' } },
    { label: '重复组数量', value: duplicates(ordinary).size, icon: Copy, f: { type: 'bookmark', duplicate: 'yes' } },
  ];
  const groups = useMemo(() => [...duplicates(rows).values()], [rows]);
  const removals = (preview ?? []).flatMap(nodes => nodes.filter(n => n.id !== (keepers[n.url!] ?? nodes[0].id) && !n.readOnly && !n.fixed));
  return <>
    <div className="stats-grid">{metrics.map(m => <button className="stat-card" key={m.label} onClick={() => setFilter({ ...defaultFilter, ...m.f })}><span>{m.label}<m.icon size={19}/></span><strong>{m.value.toLocaleString()}</strong><small>{m.label === '检测覆盖' ? `${ordinary.length ? Math.round(m.value / ordinary.length * 100) : 0}% · 不含过期结果` : '点击筛选结果'}</small></button>)}</div>
    <div className="dashboard-filters">
      <input aria-label="高级搜索" placeholder="名称或 URL" value={filter.query} onChange={e => setFilter({ ...filter, query: e.target.value })}/>
      <select aria-label="看板目录范围" value={filter.folderId} onChange={e => setFilter({ ...filter, folderId: e.target.value })}><option value="">全库</option>{records.filter(n => n.parentId && n.url === undefined && !n.inTrash).map(n => <option key={n.id} value={n.id}>{[...n.path, n.title].join(' / ')}（含子目录）</option>)}</select>
      <input aria-label="域名筛选" placeholder="域名包含" value={filter.domain} onChange={e => setFilter({ ...filter, domain: e.target.value })}/>
      <select aria-label="类型筛选" value={filter.type} onChange={e => setFilter({ ...filter, type: e.target.value })}><option value="all">所有类型</option><option value="bookmark">书签</option><option value="folder">文件夹</option></select>
      <select aria-label="状态筛选" value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}><option value="all">全部状态</option><option value="checked">已有有效检测</option><option value="issues">所有异常</option>{Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <select aria-label="重复筛选" value={filter.duplicate} onChange={e => setFilter({ ...filter, duplicate: e.target.value })}><option value="all">不限重复</option><option value="yes">重复 URL</option><option value="no">唯一 URL</option></select>
      <button onClick={() => setFilter(defaultFilter)}>清除筛选</button><button onClick={onCheck}>检测链接</button><button disabled={busy || !groups.length} onClick={() => { setKeepers({}); setPreview(groups); }}>重复处理预览</button>
    </div>
    {preview && <Modal title="重复处理预览" wide onClose={() => setPreview(undefined)}>
      <p>仅处理当前筛选结果中的完整 URL 重复项。选定保留项，其余可写副本列入回收；范围外项目保持原位。</p>
      <div className="duplicate-preview">{preview.map(nodes => <section className="duplicate-group" key={nodes[0].url}><header><strong>{nodes[0].url}</strong></header>{nodes.map(n => <label className="duplicate-item" key={n.id}><input type="radio" name={n.url} checked={(keepers[n.url!] ?? nodes[0].id) === n.id} onChange={() => setKeepers(s => ({ ...s, [n.url!]: n.id }))}/><span><strong>{n.title}</strong><small>{n.path.join(' / ')}</small></span><b>{(keepers[n.url!] ?? nodes[0].id) === n.id ? '保留' : n.readOnly || n.fixed ? '只读 · 保留' : '将回收'}</b><button onClick={e => { e.preventDefault(); setPreview(undefined); onLocate(n); }}>定位</button></label>)}</section>)}</div>
      <div className="modal-actions"><span>将回收 {removals.length} 项</span><button onClick={() => setPreview(undefined)}>取消</button><button className="primary" disabled={busy || !removals.length} onClick={() => { void edit({ kind: 'trash', nodes: removals.map(expected) }, false); setPreview(undefined); }}>确认回收列出的副本</button></div>
    </Modal>}
  </>;
}
