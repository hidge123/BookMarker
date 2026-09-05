import { parse, stringify } from 'lossless-json';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { flatten } from './tree';
import type { BackupData, BrowserNode, ImportNode, NodeMetadata, ParsedImport, SourceFile } from './types';

const MAX_FILE = 128 * 1024 * 1024;
const textValue = (value: unknown): string => value == null ? '' : String(value);
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function parseHtml(text: string): ImportNode[] {
  const doc = new DOMParser().parseFromString(text.replace(/<\/?p(?:\s[^>]*)?>/gi, ''), 'text/html');
  const root = doc.querySelector('dl'); if (!root) throw new Error('未找到书签列表（DL），请使用浏览器导出的 HTML 文件');
  let counter = 0;
  const attrs = (el: Element) => Object.fromEntries([...el.attributes].map(a => [a.name, a.value]));
  const list = (el: Element): ImportNode[] => {
    const nodes: ImportNode[] = []; let folder: ImportNode | undefined;
    for (const child of el.children) {
      if (child.tagName === 'DT') {
        const a = [...child.children].find(e => e.tagName === 'A');
        const h = [...child.children].find(e => e.tagName === 'H3');
        if (a) { nodes.push({ key: `html-${++counter}`, title: a.textContent ?? '', url: a.getAttribute('href') ?? '', raw: { attributes: attrs(a), html: child.outerHTML } }); folder = undefined; }
        else if (h) { folder = { key: `html-${++counter}`, title: h.textContent ?? '', children: [], raw: { attributes: attrs(h) } }; nodes.push(folder); }
        const nested = [...child.children].find(e => e.tagName === 'DL');
        if (nested) { if (folder) folder.children = list(nested); else nodes.push(...list(nested)); }
      } else if (child.tagName === 'DL') { if (folder) folder.children = list(child); else nodes.push(...list(child)); }
      else if (child.tagName === 'DD' && nodes.length) { const last = nodes.at(-1)!; last.raw = { ...(last.raw as object), description: child.textContent }; }
    }
    return nodes;
  };
  return list(root);
}
function parseJson(text: string): { format: string; nodes: ImportNode[] } {
  const data = parse(text) as Record<string, any>;
  if (!data || typeof data !== 'object') throw new Error('不是支持的书签 JSON');
  let count = 0;
  const convert = (n: Record<string, any>, path: string, firefox: boolean, depth = 0): ImportNode | undefined => {
    if (depth > 100) throw new Error('书签目录超过 100 层');
    if (!n || typeof n !== 'object') throw new Error('无效的书签节点');
    if (firefox && (n.type === 'text/x-moz-place-separator' || textValue(n.typeCode) === '3')) return undefined;
    const url = firefox ? n.uri : n.url;
    const node: ImportNode = { key: `json-${++count}`, sourcePath: path, title: textValue(firefox ? n.title : n.name), raw: stringify({ ...n, children: undefined }) };
    if (url !== undefined) node.url = textValue(url);
    else if (Array.isArray(n.children) || n.type === 'folder' || n.type === 'text/x-moz-place-container' || textValue(n.typeCode) === '2') node.children = (n.children ?? []).map((c: Record<string, any>, i: number) => convert(c, `${path}/children/${i}`, firefox, depth + 1)).filter(Boolean);
    else return undefined;
    return node;
  };
  if (data.roots && typeof data.roots === 'object') return { format: 'Chromium Bookmarks JSON', nodes: Object.entries(data.roots).map(([key, value]) => convert(value as Record<string, any>, `roots/${key}`, false)).filter(Boolean) as ImportNode[] };
  if (data.type === 'text/x-moz-place-container' || data.children || data.typeCode) { const root = convert(data, 'root', true); return { format: 'Firefox JSON', nodes: root?.children ?? (root ? [root] : []) }; }
  throw new Error('仅支持 Chromium Bookmarks JSON 和 Firefox 未压缩 JSON；jsonlz4 请先用 Firefox 导出 HTML');
}
export function fromBrowserTree(tree: BrowserNode[], metadata: NodeMetadata[] = []): ImportNode[] {
  const meta = new Map(metadata.map(m => [m.id, m]));
  const convert = (n: BrowserNode): ImportNode => ({ key: n.id, title: n.title, url: n.url, children: n.url === undefined ? (n.children ?? []).map(convert) : undefined, raw: { browser: { ...n, children: undefined }, metadata: meta.get(n.id) }, metadata: meta.get(n.id), sourcePath: `browser/${n.id}` });
  return tree.flatMap(n => n.parentId ? [convert(n)] : (n.children ?? []).map(convert));
}
export function importStats(nodes: ImportNode[]): { bookmarks: number; folders: number } {
  let bookmarks = 0; let folders = 0; const stack = [...nodes];
  while (stack.length) { const n = stack.pop()!; if (n.url !== undefined) bookmarks++; else folders++; stack.push(...(n.children ?? [])); if (bookmarks + folders > 200000) throw new Error('一次最多导入 200,000 个节点，请拆分文件'); }
  return { bookmarks, folders };
}
export function decodeBackup(bytes: Uint8Array): BackupData {
  let total = 0;
  const files = unzipSync(bytes, { filter: file => { total += file.originalSize; if (total > MAX_FILE * 4) throw new Error('备份解压后过大'); return true; } });
  if (!files['project.json']) throw new Error('ZIP 中没有 BookMarker project.json');
  const data = JSON.parse(strFromU8(files['project.json'])) as BackupData;
  if (data.format !== 'bookmarker-project' || data.version !== 1 || !Array.isArray(data.tree) || !Array.isArray(data.sources) || !Array.isArray(data.metadata)) throw new Error('不支持的项目备份版本');
  for (const source of data.sources) {
    const raw = files[`originals/${source.id}`]; if (!raw) throw new Error(`缺少原文件：${source.name}`); source.bytes = Array.from(raw);
  }
  return data;
}
export async function parseFile(name: string, bytes: Uint8Array): Promise<ParsedImport> {
  if (bytes.length > MAX_FILE) throw new Error('单个文件最大 128 MiB');
  let format: string; let nodes: ImportNode[]; const warnings: string[] = [];
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const backup = decodeBackup(bytes);
    for (const source of backup.sources) if (await sha256(new Uint8Array(source.bytes)) !== source.sha256) throw new Error(`原文件校验失败：${source.name}`);
    format = 'BookMarker 项目 ZIP'; nodes = fromBrowserTree(backup.tree, backup.metadata);
    warnings.push('以新节点恢复到导入目录，不复用备份的节点 ID。原文件、历史、检测结果和快照完整保存在此 ZIP 原件中；旧检测结果不视为新节点的有效检测。');
  } else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    if (text.trimStart().startsWith('<')) { format = '浏览器 HTML'; nodes = parseHtml(text); }
    else ({ format, nodes } = parseJson(text));
  }
  const stats = importStats(nodes); if (!stats.bookmarks && !stats.folders) warnings.push('文件内没有可写入的书签或目录。');
  warnings.push('标签、图标、未知字段及高精度数字保存在原件与扩展元数据中；浏览器 API 只接受标题、URL 和目录结构。');
  const source: SourceFile = { id: crypto.randomUUID(), name, bytes: Array.from(bytes), sha256: await sha256(bytes), format, importedAt: Date.now() };
  return { format, nodes, warnings, source };
}
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function exportHtml(tree: BrowserNode[], metadata: NodeMetadata[]): string {
  const trash = new Set(flatten(tree, metadata).filter(n => n.inTrash).map(n => n.id));
  const render = (nodes: BrowserNode[], depth: number): string => nodes.filter(n => !trash.has(n.id)).map(n => {
    if (!n.parentId) return render(n.children ?? [], depth);
    const indent = '    '.repeat(depth); const added = n.dateAdded ? ` ADD_DATE="${Math.floor(n.dateAdded / 1000)}"` : '';
    return n.url !== undefined ? `${indent}<DT><A HREF="${escape(n.url)}"${added}>${escape(n.title)}</A>\n` : `${indent}<DT><H3${added}>${escape(n.title)}</H3>\n${indent}<DL><p>\n${render(n.children ?? [], depth + 1)}${indent}</DL><p>\n`;
  }).join('');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>BookMarker 书签</TITLE>\n<H1>BookMarker 书签</H1>\n<DL><p>\n${render(tree, 1)}</DL><p>\n`;
}
export function encodeBackup(data: BackupData): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const source of data.sources) files[`originals/${source.id}`] = new Uint8Array(source.bytes);
  files['project.json'] = strToU8(JSON.stringify({ ...data, sources: data.sources.map(s => ({ ...s, bytes: undefined })) }));
  files['README.txt'] = strToU8('BookMarker 项目备份 v1\n在 BookMarker 中选择“导入”，预览后恢复为新节点。\noriginals 内的文件为逐字节原件；SHA-256 校验值见 project.json。\n备份可能包含私人 URL、元数据和历史，请自行妥善保管。');
  return zipSync(files, { level: 6 });
}
