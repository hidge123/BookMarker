import * as db from './store';
import { BookmarkEngine } from './engine';
import { CheckRunner, getSettings, sanitizeSettings } from './checker';
import type { AppState, BackupData, Message, ParsedImport } from './types';

let notifyTimer: ReturnType<typeof setTimeout> | undefined;
function notify() { if (!notifyTimer) notifyTimer = setTimeout(() => { notifyTimer = undefined; chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {}); }, 100); }
const engine = new BookmarkEngine(chrome.bookmarks, notify); const checker = new CheckRunner(undefined, notify);
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> { const next = chain.then(work); chain = next.catch(() => {}); return next; }
let ready: Promise<void> | undefined;
function initialize() { return ready ??= serial(async () => { await db.profileId(); await engine.recover(); await checker.recover(); await engine.dailySnapshot(); await chrome.alarms.create('bookmarker-resume', { periodInMinutes: 0.5 }); }); }
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  let more = false;
  try { await initialize(); const results = await Promise.allSettled([serial(() => engine.pump()), checker.pump()]); for (const result of results) if (result.status === 'fulfilled') more ||= result.value; else console.error('BookMarker task:', result.reason); }
  finally { ticking = false; if (more) setTimeout(() => void tick(), 50); }
}
async function state(): Promise<AppState> {
  const [tree, metadata, operations, snapshots, results, jobs, settings, profileId] = await Promise.all([chrome.bookmarks.getTree(), db.all('metadata'), db.all('operations'), db.all('snapshots'), db.all('results'), db.all('jobs'), getSettings(), db.profileId()]);
  const urls = new Map<string, string | undefined>(); const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => { for (const n of nodes) { urls.set(n.id, n.url); walk(n.children ?? []); } }; walk(tree);
  return { tree, metadata, operations: operations.sort((a, b) => b.createdAt - a.createdAt), snapshots: snapshots.sort((a, b) => b.createdAt - a.createdAt).map(({ tree: _t, metadata: _m, ...s }) => s), results: results.map(r => ({ ...r, stale: urls.get(r.nodeId) !== r.url })), jobs: jobs.sort((a, b) => b.createdAt - a.createdAt), settings, profileId };
}
async function handle(message: Message): Promise<unknown> {
  await initialize();
  switch (message.type) {
    case 'state': return state();
    case 'edit': { const result = await serial(() => engine.submit(message.command)); void tick(); return result; }
    case 'import-stage': {
      if (!message.stageId.startsWith('import:')) throw new Error('无效的导入预览');
      const staged = await db.get('kv', message.stageId); if (!staged) throw new Error('导入预览已失效，请重新选择文件');
      const parsed = staged.value as ParsedImport;
      const op = await serial(() => engine.submit({ kind: 'import', parentId: message.parentId, folderTitle: message.folderTitle, parsed })); void tick(); return op;
    }
    case 'snapshot': return serial(() => engine.snapshot(message.label));
    case 'backup': return serial(async (): Promise<BackupData> => ({ ...await state(), snapshots: await db.all('snapshots'), sources: await db.all('sources'), format: 'bookmarker-project', version: 1, exportedAt: Date.now() }));
    case 'backup-stage': return serial(async () => {
      const backup: BackupData = { ...await state(), snapshots: await db.all('snapshots'), sources: await db.all('sources'), format: 'bookmarker-project', version: 1, exportedAt: Date.now() };
      const stageId = `backup:${db.uid()}`; await db.put('kv', { id: stageId, value: backup }); return { stageId };
    });
    case 'settings': { const settings = sanitizeSettings(message.settings); await chrome.storage.local.set({ settings }); notify(); return settings; }
    case 'check': { const job = await checker.start(message.nodeIds, message.scope); void tick(); return job; }
    case 'cancel-check': await checker.cancel(message.jobId); return null;
    case 'resume': void tick(); return null;
    case 'resolve': await serial(() => engine.resolve(message.operationId, message.stepId, message.action, message.nodeId)); void tick(); return null;
    default: throw new Error('未知消息');
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('index.html')) || !message || message.type === 'changed') return;
  handle(message).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })); return true;
});
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('index.html'); const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => tab.url === url);
  if (existing?.id !== undefined) { await chrome.tabs.update(existing.id, { active: true }); if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bookmarker-resume') { void tick(); void initialize().then(() => serial(() => engine.dailySnapshot())); } });
chrome.runtime.onStartup.addListener(() => void tick());
chrome.runtime.onInstalled.addListener(() => void tick());
for (const event of [chrome.bookmarks.onCreated, chrome.bookmarks.onChanged, chrome.bookmarks.onMoved, chrome.bookmarks.onRemoved, chrome.bookmarks.onChildrenReordered, chrome.bookmarks.onImportEnded]) event.addListener(notify);
chrome.permissions.onAdded.addListener(() => void tick());
chrome.permissions.onRemoved.addListener(notify);
