import { useEffect, useRef, type ReactNode } from 'react';
import { FolderOpen, X, ExternalLink, FileText, Check } from 'lucide-react';
import { STATUS_LABELS, type CheckResult } from '../types';

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); const previous = document.activeElement as HTMLElement; return () => previous?.focus(); }, []);
  return <dialog ref={ref} className={wide ? 'modal wide' : 'modal'} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <header><div><span className="eyebrow">BOOKMARKER</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></header>{children}
  </dialog>;
}
export function Status({ result }: { result?: CheckResult }) { const key = result?.stale ? 'stale' : result?.status ?? 'unchecked'; return <span className={`status ${key}`}><i />{STATUS_LABELS[key]}</span>; }
export function Empty({ title, description, children }: { title: string; description: string; children?: ReactNode }) { return <div className="empty"><div className="empty-symbol"><FolderOpen size={34} strokeWidth={1.3}/></div><h3>{title}</h3><p>{description}</p>{children}</div>; }
export const formatTime = (date?: number) => date ? new Date(date).toLocaleString('zh-CN', { hour12: false }) : '—';
export function SafeOpen({ url, children }: { url: string; children?: ReactNode }) {
  let safe = false; try { safe = ['http:', 'https:', 'ftp:', 'file:'].includes(new URL(url).protocol); } catch { /* disabled */ }
  return <button disabled={!safe} onClick={() => window.open(url, '_blank', 'noopener,noreferrer')} title={safe ? url : '该地址不支持直接打开，可复制到浏览器使用'}>{children ?? <><ExternalLink size={15}/>打开网页</>}</button>;
}
export function Notice({ children }: { children: ReactNode }) { return <div className="notice"><FileText size={17}/><div>{children}</div></div>; }
export function Done({ children }: { children: ReactNode }) { return <span className="done-inline"><Check size={14}/>{children}</span>; }
