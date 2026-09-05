import * as db from './store';
import { flatten } from './tree';
import { DEFAULT_SETTINGS, type CheckJob, type CheckResult, type CheckStatus, type Settings } from './types';

export const CHECK_PERMISSIONS: chrome.permissions.Permissions = { permissions: ['webRequest'], origins: ['http://*/*', 'https://*/*'] };
export function privateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.home.arpa') || (!h.includes('.') && !h.includes(':'))) return true;
  if (h.includes(':')) {
    if (/^(::|::1)$/.test(h) || /^(f[cd]|fe[89ab])/.test(h)) return true;
    if (h.startsWith('::ffff:')) {
      const tail = h.slice(7); if (tail.includes('.')) return privateAddress(tail);
      const pair = tail.split(':'); if (pair.length === 2) { const n = parseInt(pair[0], 16) * 65536 + parseInt(pair[1], 16); return privateAddress([n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.')); }
    }
    return h.startsWith('ff');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224;
  }
  return false;
}
export function skipReason(url: string, allowPrivate: boolean): string | undefined {
  try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) return '非 HTTP/HTTPS 地址'; if (!allowPrivate && privateAddress(u.hostname)) return '已跳过本机、内网 IP 或已知内网域名'; if (u.username || u.password) return 'URL 含登录凭据，检测不携带凭据'; } catch { return 'URL 格式无效'; }
}
export function classify(status: number): CheckStatus {
  if (status >= 200 && status < 300) return 'ok';
  if ([401, 403, 429].includes(status)) return 'restricted';
  if (status >= 400) return 'http-error';
  return 'unknown';
}
type Observation = { url: string; method: string; controller: AbortController; error?: string; redirects: CheckResult['redirects']; requestIds: Set<string>; errorArrived: Promise<void>; resolveError: () => void };
export class NetworkObserver {
  active = new Set<Observation>(); private byRequest = new Map<string, Observation>(); private attached = false;
  constructor() { if (typeof chrome !== 'undefined') this.attach(); }
  private before = (d: chrome.webRequest.OnBeforeRequestDetails): undefined => {
    if (d.initiator !== chrome.runtime.getURL('').replace(/\/$/, '') || d.tabId !== -1) return;
    const o = [...this.active].find(o => o.url === d.url && o.method === d.method && !o.requestIds.size);
    if (o) { o.requestIds.add(d.requestId); this.byRequest.set(d.requestId, o); }
  };
  private redirect = (d: chrome.webRequest.OnBeforeRedirectDetails) => {
    const o = this.byRequest.get(d.requestId); if (o) o.redirects.push({ from: d.url, to: d.redirectUrl, status: d.statusCode });
  };
  private error = (d: chrome.webRequest.OnErrorOccurredDetails) => { const o = this.byRequest.get(d.requestId); if (o) { o.error = d.error; o.resolveError(); } };
  attach() {
    if (this.attached || !chrome.webRequest) return;
    const filter = { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest'] as chrome.webRequest.ResourceType[] };
    try { chrome.webRequest.onBeforeRequest.addListener(this.before, filter); chrome.webRequest.onBeforeRedirect.addListener(this.redirect, filter); chrome.webRequest.onErrorOccurred.addListener(this.error, filter); this.attached = true; } catch { /* Missing optional permission: fetch diagnostics remain unavailable. */ }
  }
  begin(url: string, method: string, controller: AbortController) { const u = new URL(url); u.hash = ''; let resolveError!: () => void; const errorArrived = new Promise<void>(resolve => { resolveError = resolve; }); const o: Observation = { url: u.href, method, controller, redirects: [], requestIds: new Set(), errorArrived, resolveError }; this.active.add(o); return o; }
  end(o: Observation) { this.active.delete(o); for (const id of o.requestIds) this.byRequest.delete(id); }
}
export async function probe(url: string, settings: Settings, observer?: NetworkObserver, outerSignal?: AbortSignal): Promise<Omit<CheckResult, 'id' | 'jobId' | 'nodeId'>> {
  const start = Date.now(); const base = { url, checkedAt: start, durationMs: 0, redirects: [] as CheckResult['redirects'] };
  const skipped = skipReason(url, settings.allowPrivate); if (skipped) return { ...base, status: 'skipped', reason: skipped };
  async function attempt(method: 'HEAD' | 'GET'): Promise<Omit<CheckResult, 'id' | 'jobId' | 'nodeId'>> {
    const controller = new AbortController(); let timedOut = false;
    const cancel = () => controller.abort(); outerSignal?.addEventListener('abort', cancel, { once: true }); if (outerSignal?.aborted) cancel();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, settings.timeoutMs);
    const observed = observer?.begin(url, method, controller); let bytesRead = 0;
    try {
      const response = await fetch(url, { method, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'follow', ...(method === 'GET' ? { headers: { Range: 'bytes=0-65535' } } : {}) });
      if (method === 'GET' && response.body) {
        let reader: ReadableStreamBYOBReader | undefined;
        try { reader = response.body.getReader({ mode: 'byob' }); } catch { await response.body.cancel().catch(() => {}); }
        if (reader) try {
          while (bytesRead < 65536) { const part = await reader.read(new Uint8Array(Math.min(8192, 65536 - bytesRead))); if (part.done) break; bytesRead += part.value.byteLength; }
        } finally { await reader.cancel().catch(() => {}); }
      } else await response.body?.cancel().catch(() => {});
      return { ...base, status: classify(response.status), httpStatus: response.status, finalUrl: response.url, redirects: observed?.redirects ?? [], method, bytesRead, durationMs: Date.now() - start,
        reason: [401, 403, 429].includes(response.status) ? '可能需要登录、访问权限或降低请求频率' : response.status >= 300 && response.status < 400 ? '跳转结果不足以确认可达性' : undefined };
    } catch {
      // fetch rejection can precede webRequest dispatch by several event-loop turns.
      // Keep this exact request association briefly; never infer or manufacture an error code.
      if (observed && !timedOut && !outerSignal?.aborted) await Promise.race([observed.errorArrived, new Promise(resolve => setTimeout(resolve, 150))]);
      return { ...base, status: (outerSignal?.aborted ? 'skipped' : timedOut || !observed?.error ? 'unknown' : 'network-error') as CheckStatus, method, durationMs: Date.now() - start,
        redirects: observed?.redirects ?? [], rawError: observed?.error,
        reason: outerSignal?.aborted ? '用户取消' : timedOut ? `单次尝试超过 ${settings.timeoutMs / 1000} 秒；无法确认原因` : observed?.error ? '浏览器网络错误；仅作为诊断证据' : '请求失败；未提供详细错误' };
    } finally { clearTimeout(timer); outerSignal?.removeEventListener('abort', cancel); if (observed) observer?.end(observed); }
  }
  const head = await attempt('HEAD');
  if (!outerSignal?.aborted && (head.httpStatus !== undefined && [400, 403, 404, 405, 406, 501].includes(head.httpStatus))) return attempt('GET');
  return head;
}
export class CheckRunner {
  private busy = false; private cancelled = new Set<string>(); private controllers = new Map<string, AbortController>();
  constructor(private observer = new NetworkObserver(), private notify: () => void = () => {}) {}
  async start(nodeIds: string[], scope: string): Promise<CheckJob> {
    const settings = await getSettings(); const permissionGranted = await chrome.permissions.contains(CHECK_PERMISSIONS);
    const ids = new Set(nodeIds); const records = flatten(await chrome.bookmarks.getTree(), await db.all('metadata'));
    const items = records.filter(n => ids.has(n.id) && n.url !== undefined && !n.inTrash).map(n => ({ nodeId: n.id, url: n.url!, state: 'pending' as const }));
    if (!items.length) throw new Error('范围内没有可检测的书签');
    const job: CheckJob = { id: db.uid(), createdAt: Date.now(), scope, status: 'queued', items, allowPrivate: settings.allowPrivate, permissionGranted };
    await db.put('jobs', job); this.notify(); return job;
  }
  async recover() { for (const job of await db.all('jobs')) if (['queued', 'running'].includes(job.status)) { for (const item of job.items) if (item.state === 'running') item.state = 'pending'; job.status = 'queued'; await db.put('jobs', job); } }
  async cancel(id: string) {
    this.cancelled.add(id); this.controllers.get(id)?.abort(); const job = await db.get('jobs', id); if (job) { job.status = 'cancelled'; job.completedAt = Date.now(); await db.put('jobs', job); } this.notify();
  }
  async pump(): Promise<boolean> {
    if (this.busy) return false; this.busy = true;
    try {
      const job = (await db.all('jobs')).filter(j => ['queued', 'running'].includes(j.status)).sort((a, b) => a.createdAt - b.createdAt)[0]; if (!job) return false;
      const settings = { ...await getSettings(), allowPrivate: job.allowPrivate };
      const permission = await chrome.permissions.contains(CHECK_PERMISSIONS); if (permission) this.observer.attach();
      job.permissionGranted = permission; job.status = 'running';
      const hosts = new Map<string, number>(); const urls = new Set<string>();
      const batch = job.items.filter(i => i.state === 'pending').filter(i => { let host = i.url; try { host = new URL(i.url).hostname; } catch { /* gets a skipped result */ } const n = hosts.get(host) ?? 0; if (urls.has(i.url) || n >= settings.perHost || urls.size >= settings.concurrency) return false; hosts.set(host, n + 1); urls.add(i.url); return true; });
      for (const item of batch) item.state = 'running'; await db.put('jobs', job);
      const controller = new AbortController(); this.controllers.set(job.id, controller);
      await Promise.all(batch.map(async item => {
        let current: BrowserNodeLike | undefined; try { [current] = await chrome.bookmarks.get(item.nodeId); } catch { /* deleted externally */ }
        const reason = !current || current.url !== item.url ? '书签已删除或 URL 已改变' : !permission ? '缺少检测权限；书签管理不受影响' : undefined;
        const result: CheckResult = { ...(reason ? { url: item.url, checkedAt: Date.now(), durationMs: 0, status: 'skipped' as const, reason, redirects: [] } : await probe(item.url, settings, this.observer, controller.signal)), id: `${job.id}:${item.nodeId}`, jobId: job.id, nodeId: item.nodeId };
        item.state = 'done'; if (this.cancelled.has(job.id)) job.status = 'cancelled';
        await db.write([['results', result], ['jobs', job]]); this.notify();
      }));
      if (this.cancelled.has(job.id)) job.status = 'cancelled';
      else job.status = job.items.every(i => i.state === 'done') ? 'done' : 'queued';
      if (['done', 'cancelled'].includes(job.status)) job.completedAt = Date.now();
      await db.put('jobs', job); this.controllers.delete(job.id); this.notify(); return true;
    } finally { this.busy = false; }
  }
}
type BrowserNodeLike = { url?: string };
export async function getSettings(): Promise<Settings> {
  const value = (await chrome.storage.local.get('settings')).settings as Partial<Settings> | undefined;
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...value });
}
export function sanitizeSettings(value: Settings): Settings {
  return { allowPrivate: value.allowPrivate === true, concurrency: Math.max(1, Math.min(12, Math.floor(Number(value.concurrency) || 6))), perHost: Math.max(1, Math.min(2, Math.floor(Number(value.perHost) || 2))), timeoutMs: Math.max(1000, Math.min(12000, Number(value.timeoutMs) || 12000)) };
}
