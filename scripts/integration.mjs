import { finderAcceptance, gridPerformance } from './finder-acceptance.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'test-results'); await mkdir(output, { recursive: true });
const report = { timestamp: new Date().toISOString(), checks: [], browsers: [], limitations: [] };
const temporaryDirectories = [];
const pass = (name, detail) => { report.checks.push({ name, passed: true, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const expected = n => ({ id: n.id, title: n.title, url: n.url, parentId: n.parentId, index: n.index ?? 0 });
async function launch(name, path = resolve(root, 'dist'), profile) {
  const executablePath = name === 'Edge' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const dir = profile ?? await mkdtemp(join(tmpdir(), `bookmarker-${name.toLowerCase()}-test-`));
  if (!profile) temporaryDirectories.push(dir);
  const context = await chromium.launchPersistentContext(dir, { executablePath, headless: true, viewport: { width: 1440, height: 1000 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/index.html`); await page.waitForSelector('.workspace-title');
  await page.waitForFunction(() => document.body.innerText.includes('浏览器书签已连接'));
  return { context, page, id, cdp, profile: dir, errors, version: context.browser().version() };
}
async function request(page, message) { const reply = await page.evaluate(m => chrome.runtime.sendMessage(m), message); assert(reply?.ok, reply?.error ?? 'Missing background response'); return reply.data; }
async function state(page) { return request(page, { type: 'state' }); }
async function waitAPI(page, predicate, argument) {
  for (let i = 0; i < 300; i++) { if (await page.evaluate(predicate, argument)) return; await sleep(50); }
  throw new Error('Asynchronous browser API condition timed out');
}
async function node(page, id) { return page.evaluate(async id => (await chrome.bookmarks.get(id))[0], id); }
async function waitOp(page, id) {
  for (let i = 0; i < 200; i++) { const s = await state(page); const op = s.operations.find(o => o.id === id); if (op && !['queued','running'].includes(op.status)) return op; await sleep(70); }
  throw new Error(`Operation timed out ${id}`);
}
async function edit(page, command) { const op = await request(page, { type: 'edit', command }); return waitOp(page, op.id); }
async function externalCreate(page, details) { return page.evaluate(d => chrome.bookmarks.create(d), details); }

async function management(name) {
  let env = await launch(name);
  try {
    let { page, context, id } = env; report.browsers.push({ name, version: env.version });
    const s = await state(page); const rootNode = s.tree[0]; const bar = rootNode.children.find(n => n.folderType === 'bookmarks-bar') ?? rootNode.children[0];
    const perms = await page.evaluate(() => chrome.permissions.getAll()); assert(!perms.permissions.includes('webRequest')); assert(!(perms.origins ?? []).length); pass(`${name}: optional permissions withheld`);
    const fixtures = await page.evaluate(async parentId => {
      const names = ['设计与灵感', '开发与技术', '阅读与思考', '工具箱']; const folders = [];
      for (const title of names) folders.push(await chrome.bookmarks.create({ parentId, title }));
      const items = [['Figma · 协作设计', 'https://www.figma.com/'], ['Awwwards · 优秀网页设计', 'https://www.awwwards.com/'], ['Dribbble · 设计灵感', 'https://dribbble.com/'], ['Mobbin · 界面参考库', 'https://mobbin.com/'], ['Unsplash · 自由影像', 'https://unsplash.com/'], ['Are.na · 灵感与连接', 'https://www.are.na/'], ['设计中的设计 · 阅读笔记', 'https://example.com/notes?q=设计#第一章'], ['中文 <>& 特殊字符', 'https://example.com/?a=1&b=2#x']];
      const links = []; for (const [title, url] of items) links.push(await chrome.bookmarks.create({ parentId: folders[0].id, title, url }));
      for (const [title,url] of [['MDN Web Docs','https://developer.mozilla.org/'],['TypeScript','https://www.typescriptlang.org/'],['GitHub','https://github.com/']]) await chrome.bookmarks.create({ parentId: folders[1].id, title, url });
      await chrome.bookmarks.create({ parentId: folders[2].id, title: '稍后阅读', url: 'https://example.com/read' });
      return { folders, links };
    }, bar.id);
    if (process.argv.includes('--finder-only')) { await finderAcceptance({ page, name, bar, state, node, edit, expected, externalCreate, waitAPI, pass, output }); return; }
    await page.getByRole('button', { name: `展开 ${bar.title}`, exact: true }).click();
    await page.locator('.tree-label').filter({ hasText: '设计与灵感' }).click();
    await page.waitForSelector(`[data-node-id="${fixtures.links[0].id}"]`);
    await page.locator(`[data-node-id="${fixtures.links[0].id}"]`).click();
    assert.equal(await page.locator('.details-panel').count(), 0);
    await page.locator(`[data-node-id="${fixtures.links[0].id}"]`).click({ button: 'right' });
    await page.getByRole('button', { name: '显示属性', exact: true }).click();
    await page.getByLabel('详情名称', { exact: true }).fill('Figma · 中文编辑测试');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await waitAPI(page, async id => (await chrome.bookmarks.get(id))[0].title === 'Figma · 中文编辑测试', fixtures.links[0].id);
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '列表视图', exact: true }).click();
    await page.getByLabel('详情名称').waitFor();
    pass(`${name}: default grid properties modal, list inspector, immediate editing`);
    await page.locator('.toolbar-menu>summary').filter({ hasText: '新建' }).click();
    await page.getByRole('button', { name: '新建书签', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('名称', { exact: true }).fill('浏览器规范化测试'); await modal.getByLabel('网址', { exact: true }).fill('https://EXAMPLE.COM'); await modal.getByRole('button', { name: '创建', exact: true }).click();
    await waitAPI(page, async () => (await chrome.bookmarks.search({ title: '浏览器规范化测试' })).length === 1);
    const created = await page.evaluate(async () => (await chrome.bookmarks.search({ title: '浏览器规范化测试' }))[0]); assert.equal(created.url, 'https://example.com/'); pass(`${name}: UI create and canonical URL`);
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('已完成：新建书签'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator(`[data-node-id="${fixtures.links[1].id}"]`).dragTo(page.locator(`[data-node-id="${fixtures.links[0].id}"]`), { sourcePosition: { x: 70, y: 15 }, targetPosition: { x: 70, y: 4 } });
    await waitAPI(page, async id => (await chrome.bookmarks.get(id))[0].index === 0, fixtures.links[1].id); pass(`${name}: drag to reorder`);
    const n = await node(page, fixtures.links[2].id);
    const recycled = await edit(page, { kind: 'trash', nodes: [expected(n)] }); assert.equal(recycled.status, 'done'); const after = await node(page, n.id); assert.notEqual(after.parentId, n.parentId);
    const restored = await edit(page, { kind: 'restore', nodes: [expected(after)] }); assert.equal(restored.status, 'done'); assert.equal((await node(page, n.id)).parentId, n.parentId); pass(`${name}: recycle and restore preserve ID`);
    const beforeRename = await node(page, n.id); const rename = await edit(page, { kind: 'update', changes: [{ expected: expected(beforeRename), title: '批量重命名后的标题' }] });
    const undone = await edit(page, { kind: 'undo', operationId: rename.id }); assert.equal(undone.status, 'done'); assert.equal((await node(page, n.id)).title, beforeRename.title);
    const redone = await edit(page, { kind: 'redo', operationId: undone.id }); assert.equal(redone.status, 'done'); pass(`${name}: undo and redo`);
    const stale = expected(await node(page, n.id)); await page.evaluate(id => chrome.bookmarks.update(id, { title: '外部工具的修改' }), n.id);
    const rejected = await page.evaluate(command => chrome.runtime.sendMessage({ type: 'edit', command }), { kind: 'update', changes: [{ expected: stale, title: 'must not overwrite' }] }); assert.equal(rejected.ok, false); assert.equal((await node(page, n.id)).title, '外部工具的修改');
    await page.waitForFunction(() => [...document.querySelectorAll('.item-name strong')].some(n => n.textContent === '外部工具的修改')); pass(`${name}: external synchronization and stale-write conflict`);
    const fixedReply = await page.evaluate(command => chrome.runtime.sendMessage({ type: 'edit', command }), { kind: 'trash', nodes: [expected(bar)] }); assert.equal(fixedReply.ok, false); pass(`${name}: fixed folder protection`);
    await page.locator('.toolbar-menu>summary').filter({ hasText: '整理工具' }).click();
    await page.getByRole('button', { name: '导入', exact: true }).click();
    const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>中文导入 &amp; 空目录</H3><DL><p><DT><H3>空文件夹</H3><DL><p></DL><p><DT><A HREF="https://example.com/import?a=1&amp;b=2" TAGS="标签" ICON="data:test">测试 &lt;标题&gt;</A></DL><p></DL><p>';
    await page.getByLabel('导入文件', { exact: true }).setInputFiles({ name: 'fixture.html', mimeType: 'text/html', buffer: Buffer.from(html) });
    await page.getByRole('button', { name: '确认导入', exact: true }).waitFor({ state: 'visible' });
    assert.equal((await page.evaluate(() => chrome.bookmarks.search({ title: '测试 <标题>' }))).length, 0);
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await waitAPI(page, async () => (await chrome.bookmarks.search({ title: '测试 <标题>' })).length === 1);
    const backup = await request(page, { type: 'backup' });
    assert.equal(backup.sources[0].bytes.length, Buffer.byteLength(html)); assert.deepEqual(Buffer.from(backup.sources[0].bytes), Buffer.from(html)); pass(`${name}: import preview and byte-preserved original`);
    for (const op of backup.operations.filter(o => ['queued','running'].includes(o.status))) await waitOp(page, op.id);
    await page.locator('.toolbar-menu>summary').filter({ hasText: '整理工具' }).click();
    await page.getByRole('button', { name: '导出与备份', exact: true }).click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: /完整项目备份 ZIP/ }).click();
    const downloaded = await downloadEvent; const backupBytes = await readFile(await downloaded.path()); assert(backupBytes.length > 100);
    await page.locator('.toolbar-menu>summary').filter({ hasText: '整理工具' }).click();
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await page.getByLabel('导入文件', { exact: true }).setInputFiles({ name: 'restore.zip', mimeType: 'application/zip', buffer: backupBytes });
    await page.getByRole('button', { name: '确认导入', exact: true }).waitFor();
    if (name === 'Chrome') await page.screenshot({ path: join(output, 'chrome-backup-preview.png'), fullPage: true });
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    let restoredBackup;
    for (let i = 0; i < 150; i++) { const st = await state(page); restoredBackup = st.operations.find(o => o.label === '导入 · restore.zip'); if (restoredBackup && !['queued','running'].includes(restoredBackup.status)) break; await sleep(70); }
    assert.equal(restoredBackup.status, 'done'); assert.equal((await page.evaluate(() => chrome.bookmarks.search({ title: '测试 <标题>' }))).length, 2); pass(`${name}: project ZIP download, preview and restore as new nodes`);
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('已完成：导入 · restore.zip'));
    const selectedIds = fixtures.links.slice(0, 3).map(n => n.id);
    await page.locator(`[data-node-id="${selectedIds[0]}"]`).click();
    await page.locator(`[data-node-id="${selectedIds[2]}"]`).click({ modifiers: ['Meta'] });
    assert.equal(await page.locator('.bookmark-row[aria-selected="true"]').count(), 2);
    await page.getByRole('button', { name: '取消选择', exact: true }).click();
    const visibleIds = await page.locator('.bookmark-row').evaluateAll(rows => rows.map(r => r.getAttribute('data-node-id')));
    await page.locator(`[data-node-id="${visibleIds[0]}"]`).click(); await page.locator(`[data-node-id="${visibleIds[2]}"]`).click({ modifiers: ['Shift'] }); assert.equal(await page.locator('.bookmark-row[aria-selected="true"]').count(), 3);
    await page.getByRole('button', { name: '重命名', exact: true }).click(); await page.getByLabel('前缀', { exact: true }).fill('收藏 · ');
    assert.equal(await page.locator('.preview-table>div').count(), 3); await page.getByRole('button', { name: '应用重命名', exact: true }).click();
    await waitAPI(page, async ids => (await chrome.bookmarks.get(ids)).every(n => n.title.startsWith('收藏 · ')), visibleIds.slice(0, 3)); pass(`${name}: Cmd selection, Shift range and batch rename preview`);
    const orderFolder = await externalCreate(page, { parentId: bar.id, title: '批量顺序测试' }); const orderNodes = [];
    for (const title of ['a','b','c','d']) orderNodes.push(await externalCreate(page, { parentId: orderFolder.id, title, url: `https://example.com/order/${title}` }));
    const orderOp = await edit(page, { kind: 'move', nodes: orderNodes.slice(0,2).map(expected), parentId: orderFolder.id, index: 1 }); assert.equal(orderOp.status, 'done');
    assert.deepEqual(await page.evaluate(async id => (await chrome.bookmarks.getChildren(id)).map(n => n.title), orderFolder.id), ['c','a','b','d']);
    assert.equal((await edit(page, { kind: 'undo', operationId: orderOp.id })).status, 'done'); assert.deepEqual(await page.evaluate(async id => (await chrome.bookmarks.getChildren(id)).map(n => n.title), orderFolder.id), ['a','b','c','d']); pass(`${name}: batch block reorder and reverse order undo`);
    const noPermission = await request(page, { type: 'check', nodeIds: [fixtures.links[0].id], scope: '拒绝权限测试' });
    for (let i = 0; i < 100; i++) { const st = await state(page); if (st.jobs.find(j => j.id === noPermission.id)?.status === 'done') { const r = st.results.find(r => r.jobId === noPermission.id); assert.equal(r.status, 'skipped'); assert.match(r.reason, /权限/); break; } if (i === 99) throw new Error('Denied permission check timed out'); await sleep(50); }
    pass(`${name}: missing permission yields skipped result`);
    // Restart the actual background worker through DevTools, with a queued operation in durable storage.
    const pending = await page.evaluate(async ({ parentId }) => {
      const database = await new Promise((resolve, reject) => { const r = indexedDB.open('bookmarker', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const get = (table, id) => new Promise((resolve, reject) => { const r = database.transaction(table).objectStore(table).get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const profileId = (await get('kv', 'profile')).value; const id = crypto.randomUUID(); const stepId = crypto.randomUUID();
      const op = { id, profileId, label: '后台中断创建测试', createdAt: Date.now() + 100, status: 'running', warnings: [], steps: [{ id: stepId, kind: 'create', state: 'running', parentId, title: '不重复创建', url: 'https://example.com/recovery' }] };
      const actual = await chrome.bookmarks.create({ parentId, title: '不重复创建', url: 'https://example.com/recovery' });
      await new Promise((resolve, reject) => { const tx = database.transaction('operations', 'readwrite'); tx.objectStore('operations').put(op); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); database.close(); return { id, stepId, nodeId: actual.id };
    }, { parentId: fixtures.folders[0].id });
    const target = await context.newCDPSession(page); await target.send('ServiceWorker.enable'); await target.send('ServiceWorker.stopAllWorkers'); await request(page, { type: 'resume' });
    let recoveryState; for (let i = 0; i < 100; i++) { recoveryState = (await state(page)).operations.find(o => o.id === pending.id); if (recoveryState?.status === 'needs-review') break; await sleep(50); }
    assert.equal(recoveryState.status, 'needs-review');
    await request(page, { type: 'resolve', operationId: pending.id, stepId: pending.stepId, action: 'adopt', nodeId: pending.nodeId }); assert.equal((await waitOp(page, pending.id)).status, 'done');
    assert.equal((await page.evaluate(() => chrome.bookmarks.search({ title: '不重复创建' }))).length, 1); pass(`${name}: real service worker stop and uncertain-create reconciliation`);
    await target.detach();
    // Restore a clean display selection for the delivered visual QA artifact.
    await page.locator('.tree-label').filter({ hasText: '设计与灵感' }).click();
    await page.locator(`[data-node-id="${fixtures.links[0].id}"]`).click();
    if (await page.getByRole('button', { name: '关闭提示', exact: true }).count()) await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    await page.waitForTimeout(350); await page.screenshot({ path: join(output, `${name.toLowerCase()}-manager.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.getByRole('button', { name: '图标视图', exact: true }).click();
    await page.screenshot({ path: join(output, `${name.toLowerCase()}-grid.png`) });
    await page.getByRole('button', { name: '列表视图', exact: true }).click();
    pass(`${name}: rendered grid and list layout without horizontal overflow`);
    await finderAcceptance({ page, name, bar, state, node, edit, expected, externalCreate, waitAPI, pass, output });
    {
      const many = await externalCreate(page, { parentId: bar.id, title: '10,000 书签性能测试' });
      const start = performance.now();
      await page.evaluate(async parentId => { for (let start = 0; start < 10000; start += 100) await Promise.all(Array.from({ length: 100 }, (_, offset) => { const i = start + offset; return chrome.bookmarks.create({ parentId, title: `性能测试 ${String(i).padStart(5, '0')}`, url: `https://example.com/performance/${i}` }); })); }, many.id);
      const fixtureMs = Math.round(performance.now() - start);
      await page.locator('.tree-label').filter({ hasText: '10,000 书签性能测试' }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="书签列表"]')?.getAttribute('aria-rowcount') === '10000');
      const rendered = await page.locator('.bookmark-row').count(); assert(rendered < 50, `Rendered ${rendered} rows`);
      const searchStart = performance.now(); await page.getByLabel('搜索书签', { exact: true }).fill('性能测试 09999'); await page.waitForFunction(() => document.querySelectorAll('.bookmark-row').length === 1); const searchMs = Math.round(performance.now() - searchStart);
      assert(searchMs < 2000, `Search took ${searchMs} ms`); await page.screenshot({ path: join(output, `${name.toLowerCase()}-10000-search.png`), fullPage: true }); pass(`${name}: 10,000 bookmark virtual list and search`, `rendered=${rendered}, search=${searchMs}ms, fixture=${fixtureMs}ms`);
      await page.getByLabel('搜索书签', { exact: true }).fill('');
      await page.waitForFunction(() => document.querySelector('[aria-label="书签列表"]')?.getAttribute('aria-rowcount') === '10000');
      const selectionStart = performance.now(); await page.getByLabel('全选当前列表', { exact: true }).check(); await page.getByRole('button', { name: '移动', exact: true }).click();
      await page.getByRole('dialog').waitFor(); const selectionMs = Math.round(performance.now() - selectionStart); assert(selectionMs < 2000);
      await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click(); pass(`${name}: 10,000 selection and batch move preview`, `${selectionMs}ms`);
      await gridPerformance({ page, name, pass, output });
    }
    assert.deepEqual(env.errors, []); pass(`${name}: no page runtime errors`);
    const countBefore = (await request(page, { type: 'backup' })).operations.length;
    const profile = env.profile; await context.close(); env = await launch(name, resolve(root, 'dist'), profile);
    const restartedState = await state(env.page); assert(restartedState.operations.length >= countBefore); assert(restartedState.metadata.length > 0); pass(`${name}: browser restart retains logs and metadata`);
  } catch (error) { await env.page.screenshot({ path: join(output, `${name.toLowerCase()}-failure.png`) }).catch(() => {}); await writeFile(join(output, 'failure-state.json'), JSON.stringify({ state: await state(env.page), text: await env.page.locator('body').innerText(), errors: env.errors }, null, 2)).catch(() => {}); throw error; } finally { await env.context.close(); }
}

async function network() {
  const seen = []; let active = 0; let maxActive = 0;
  const server = createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization, range: req.headers.range });
    active++; maxActive = Math.max(maxActive, active); res.on('close', () => active--);
    const status = { '/notfound': 404, '/gone': 410, '/forbidden': 403, '/unauthorized': 401, '/rate': 429, '/error': 503 }[req.url];
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/ok' }); res.end(); }
    else if (req.url === '/head-fallback') { res.writeHead(req.method === 'HEAD' ? 405 : 200); res.end(req.method === 'HEAD' ? '' : 'x'.repeat(100000)); }
    else if (req.url === '/network-error') req.socket.destroy();
    else if (req.url === '/timeout' || req.url?.startsWith('/slow')) setTimeout(() => { if (!res.destroyed) { res.writeHead(200); res.end('delayed'); } }, 2500);
    else { res.writeHead(status ?? 200, { 'Content-Type': 'text/plain', 'Set-Cookie': 'test=must-not-return' }); res.end(req.method === 'HEAD' ? '' : 'controlled response'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  // A disposable fixture grants the *same* optional permissions up front for headless network acceptance.
  // The delivered manifest remains optional; production permission absence is tested above in both browsers.
  const fixture = await mkdtemp(join(tmpdir(), 'bookmarker-network-extension-')); await cp(resolve(root, 'dist'), fixture, { recursive: true });
  temporaryDirectories.push(fixture);
  const manifest = JSON.parse(await readFile(join(fixture, 'manifest.json'), 'utf8')); manifest.permissions.push('webRequest'); manifest.host_permissions = manifest.optional_host_permissions; delete manifest.optional_permissions; delete manifest.optional_host_permissions; await writeFile(join(fixture, 'manifest.json'), JSON.stringify(manifest));
  let env;
  try {
    env = await launch('Chrome', fixture); const { page } = env;
    const s = await state(page); const parentId = s.tree[0].children[0].id;
    await request(page, { type: 'settings', settings: { ...s.settings, allowPrivate: true, timeoutMs: 1000 } });
    const paths = ['/ok','/notfound','/gone','/forbidden','/unauthorized','/rate','/error','/redirect','/head-fallback','/timeout','/network-error'];
    const nodes = []; for (const path of paths) nodes.push(await externalCreate(page, { parentId, title: path, url: `http://127.0.0.1:${port}${path}` }));
    const job = await request(page, { type: 'check', nodeIds: nodes.map(n => n.id), scope: '受控 HTTP 集成测试' });
    let finished;
    for (let i = 0; i < 300; i++) { const s = await state(page); if (s.jobs.find(j => j.id === job.id)?.status === 'done') { finished = s; break; } await sleep(100); }
    assert(finished, 'Network job completion'); const results = finished.results.filter(r => r.jobId === job.id); assert.equal(results.length, nodes.length);
    const byPath = new Map(results.map(r => [new URL(r.url).pathname, r]));
    for (const [path,status] of Object.entries({ '/ok':'ok','/notfound':'http-error','/gone':'http-error','/forbidden':'restricted','/unauthorized':'restricted','/rate':'restricted','/error':'http-error','/redirect':'ok','/head-fallback':'ok','/timeout':'unknown','/network-error':'network-error' })) assert.equal(byPath.get(path).status, status, `${path}: ${JSON.stringify(byPath.get(path))}`);
    assert.equal(byPath.get('/head-fallback').bytesRead, 65536); assert.equal(byPath.get('/head-fallback').method, 'GET'); assert.match(byPath.get('/network-error').rawError, /^net::/); assert.equal(byPath.get('/redirect').redirects[0].status, 302); assert.equal(byPath.get('/redirect').finalUrl, `http://127.0.0.1:${port}/ok`);
    assert(seen.every(r => !r.cookie && !r.authorization)); assert(maxActive <= 2, `Per-host concurrency was ${maxActive}`);
    pass('Network: controlled HTTP, restricted access, redirect, raw errors, timeout, bounded GET, no credentials', `max per-host=${maxActive}`);
    // Confirm stale results never silently apply to a changed URL.
    await page.evaluate(({ id, port }) => chrome.bookmarks.update(id, { url: `http://127.0.0.1:${port}/changed` }), { id: nodes[0].id, port }); assert((await state(page)).results.find(r => r.nodeId === nodes[0].id).stale); pass('Network: URL change marks result stale');
    await request(page, { type: 'settings', settings: { ...s.settings, allowPrivate: false } });
    const skippedJob = await request(page, { type: 'check', nodeIds: [nodes[0].id], scope: '内网过滤' });
    for (let i = 0; i < 100; i++) { const r = (await state(page)).results.find(r => r.jobId === skippedJob.id); if (r) { assert.equal(r.status, 'skipped'); assert.match(r.reason, /内网/); break; } if (i === 99) throw new Error('Private skip timed out'); await sleep(50); } pass('Network: default private filter');
    await request(page, { type: 'settings', settings: { ...s.settings, allowPrivate: true, timeoutMs: 5000 } });
    const slows = []; for (let i = 0; i < 8; i++) slows.push(await externalCreate(page, { parentId, title: `slow-${i}`, url: `http://127.0.0.1:${port}/slow${i}` }));
    const cancelJob = await request(page, { type: 'check', nodeIds: slows.map(n => n.id), scope: '取消测试' }); await sleep(200); await request(page, { type: 'cancel-check', jobId: cancelJob.id }); await sleep(100); assert.equal((await state(page)).jobs.find(j => j.id === cancelJob.id).status, 'cancelled'); pass('Network: cancellation persists');
    const resumeJob = await request(page, { type: 'check', nodeIds: slows.slice(0, 3).map(n => n.id), scope: '重启续跑' });
    await sleep(200); const profile = env.profile; await env.context.close(); env = await launch('Chrome', fixture, profile);
    let resumed;
    for (let i = 0; i < 200; i++) { const s = await state(env.page); resumed = s.jobs.find(j => j.id === resumeJob.id); if (resumed?.status === 'done') break; await sleep(100); }
    assert.equal(resumed.status, 'done'); const rr = (await state(env.page)).results.filter(r => r.jobId === resumeJob.id); assert.equal(rr.length, 3); pass('Network: browser restart resumes unfinished queue without duplicate result IDs');
    await writeFile(join(output, 'controlled-network-results.json'), JSON.stringify(results, null, 2));
    report.limitations.push('Headless controlled-network tests use a disposable copy with optional permissions pregranted. Interactive permission grant UI remains a manual installation check. The unchanged release manifest is tested for missing permissions in both browsers.');
  } finally { if (env) await env.context.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
}

try { if (!process.argv.includes('--network-only')) { await management('Chrome'); if (!process.argv.includes('--chrome-only')) await management('Edge'); } if (!process.argv.includes('--chrome-only')) await network(); }
catch (error) { report.failure = String(error.stack ?? error); console.error(error); process.exitCode = 1; }
finally { await writeFile(join(output, 'integration-report.json'), JSON.stringify(report, null, 2)); for (const path of temporaryDirectories) await rm(path, { recursive: true, force: true }); console.log(`Integration checks completed: ${report.checks.length}`); }
