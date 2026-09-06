import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function finderAcceptance({ page, name, bar, state, node, edit, expected, externalCreate, waitAPI, pass, output }) {
  const row = id => page.locator(`[data-node-id="${id}"]`);
  const idle = async () => { await page.waitForFunction(() => !document.querySelector('.progress-strip')); };
  const selectFolder = async title => { await page.locator('.tree-label').filter({ hasText: title }).click(); };
  const root = await externalCreate(page, { parentId: bar.id, title: 'Finder 验收' });
  const src = await externalCreate(page, { parentId: root.id, title: '来源目录' });
  const nested = await externalCreate(page, { parentId: src.id, title: '嵌套目录' });
  const a = await externalCreate(page, { parentId: nested.id, title: 'nested A', url: 'https://example.com/nested-a' });
  const b = await externalCreate(page, { parentId: src.id, title: 'root B', url: 'https://example.com/root-b' });
  const destination = await externalCreate(page, { parentId: root.id, title: '目标空目录' });
  const expandBar = page.getByRole('button', { name: `展开 ${bar.title}`, exact: true }); if (await expandBar.count()) await expandBar.click();
  await selectFolder('Finder 验收'); await page.getByRole('button', { name: '图标视图', exact: true }).click();
  await row(src.id).waitFor(); assert.equal(await page.locator('.details-panel').count(), 0);
  assert.equal(await page.locator('.bookmark-row').count(), 2);
  // File-style new folder, rename, double-click entry and back navigation without the tree.
  const blank = await page.locator('.virtual-list').boundingBox();
  await page.mouse.click(blank.x + 8, blank.y + 200, { button: 'right' });
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('新目录'); await page.getByRole('button', { name: '创建', exact: true }).click();
  await waitAPI(page, async () => (await chrome.bookmarks.search({ title: '新目录' })).length === 1); await idle();
  const added = await page.evaluate(async () => (await chrome.bookmarks.search({ title: '新目录' }))[0]);
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute('aria-selected') === 'true', added.id);
  await page.keyboard.press('F2'); const rename = page.getByLabel('就地重命名'); await rename.fill('新目录 · 已命名'); await rename.press('Enter');
  await waitAPI(page, async id => (await chrome.bookmarks.get(id))[0].title === '新目录 · 已命名', added.id); await idle();
  await row(added.id).click(); await page.keyboard.press('F2'); await page.getByLabel('就地重命名').fill('不能保存'); await page.getByLabel('就地重命名').press('Escape'); assert.equal((await node(page, added.id)).title, '新目录 · 已命名');
  await row(added.id).dblclick(); await page.waitForFunction(() => document.querySelector('.directory-title')?.textContent === '新目录 · 已命名');
  assert.equal(await page.locator('.bookmark-row').count(), 0); await page.getByRole('button', { name: '后退', exact: true }).click(); await row(src.id).waitFor();
  pass(`${name}: blank context creation selects result, inline F2 save/cancel, folder double-click and back`);

  // Shared selection and full nested copy via the internal clipboard.
  await row(src.id).click(); await page.keyboard.press('Meta+c');
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  assert.equal(await row(src.id).getAttribute('aria-selected'), 'true'); await page.getByLabel('详情名称').waitFor();
  await page.getByRole('button', { name: '图标视图', exact: true }).click();
  assert.equal(await row(src.id).getAttribute('aria-selected'), 'true'); assert.equal(await page.locator('.details-panel').count(), 0);
  await row(destination.id).dblclick(); await page.keyboard.press('Meta+v');
  await waitAPI(page, async parentId => (await chrome.bookmarks.getChildren(parentId)).length === 1, destination.id); await idle();
  const copied = await page.evaluate(async id => (await chrome.bookmarks.getChildren(id))[0], destination.id);
  assert.notEqual(copied.id, src.id);
  const copyTree = await page.evaluate(async id => (await chrome.bookmarks.getSubTree(id))[0], copied.id);
  assert.deepEqual(copyTree.children.map(n => n.title), ['嵌套目录', 'root B']); assert.equal(copyTree.children[0].children[0].title, 'nested A');
  assert.equal((await node(page, a.id)).parentId, nested.id);
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute('aria-selected') === 'true', copied.id);
  await page.keyboard.press('Meta+v'); await waitAPI(page, async id => (await chrome.bookmarks.getChildren(id)).length === 2, destination.id); await idle();
  assert.deepEqual(await page.evaluate(async id => (await chrome.bookmarks.getChildren(id)).map(n => n.title), destination.id), ['来源目录', '来源目录 副本']);
  const copyOp = (await state(page)).operations.find(o => o.label === '复制 1 项' && o.steps[0].after?.title === '来源目录 副本');
  assert.equal((await edit(page, { kind: 'undo', operationId: copyOp.id })).status, 'done'); await idle();
  pass(`${name}: shared view selection, cross-directory nested copy, suffix names and undo`);

  // Cut stays pending across navigation; Escape cancels; pasting moves the original ID.
  await page.getByRole('button', { name: '上一级', exact: true }).click(); await row(src.id).dblclick(); await row(b.id).click(); await page.keyboard.press('Meta+x');
  assert.match(await row(b.id).getAttribute('class'), /cut/); await page.keyboard.press('Escape'); assert(!/\bcut\b/.test(await row(b.id).getAttribute('class')));
  await row(b.id).click(); await page.keyboard.press('Meta+x'); await page.getByRole('button', { name: '上一级', exact: true }).click(); await row(added.id).dblclick(); await page.keyboard.press('Meta+v');
  await waitAPI(page, async ({ id, parent }) => (await chrome.bookmarks.get(id))[0].parentId === parent, { id: b.id, parent: added.id }); await idle();
  await row(b.id).waitFor(); assert(!/\bcut\b/.test(await row(b.id).getAttribute('class')));
  await page.getByRole('button', { name: '后退', exact: true }).click(); await page.getByRole('button', { name: '前进', exact: true }).click(); await row(b.id).waitFor();
  // Text entry keeps Cmd+A / Cmd+X and Delete local to the input.
  const q = page.getByLabel('搜索书签', { exact: true }); await q.fill('root B'); await q.press('Meta+a'); await q.press('Backspace');
  assert.equal(await q.inputValue(), ''); assert.equal((await node(page, b.id)).parentId, added.id);
  pass(`${name}: cut dimming, Escape cancellation, paste preserves ID and input shortcuts`);

  // Search defaults to current subtree and returns a result to its real parent path.
  await selectFolder('Finder 验收'); await q.fill('NESTED-a'); await row(a.id).waitFor();
  assert.equal(await page.locator('.bookmark-row').count(), 2); // original plus the kept subtree copy
  await row(a.id).click(); assert((await page.locator('.path-bar').innerText()).includes('嵌套目录'));
  await row(a.id).click({ button: 'right' }); await page.getByRole('button', { name: '在书签管理器中显示', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.directory-title')?.textContent === '嵌套目录');
  assert.equal(await row(a.id).getAttribute('aria-selected'), 'true'); await page.getByRole('button', { name: '后退', exact: true }).click(); assert.equal(await q.inputValue(), 'NESTED-a');
  await q.fill('');
  pass(`${name}: recursive case-insensitive basic search, actual path, locate and history restores search`);

  // Display sorting is read-only; explicit application changes browser order.
  const childrenBefore = await page.evaluate(async id => (await chrome.bookmarks.getChildren(id)).map(n => n.id), root.id);
  const opsBefore = (await state(page)).operations.length;
  await page.locator('.toolbar-menu>summary').filter({ hasText: '整理工具' }).click(); await page.getByLabel('显示排序').selectOption('name');
  assert.deepEqual(await page.evaluate(async id => (await chrome.bookmarks.getChildren(id)).map(n => n.id), root.id), childrenBefore);
  assert.equal((await state(page)).operations.length, opsBefore);
  const visualOrder = await page.locator('.bookmark-row').evaluateAll(ns => ns.map(n => n.getAttribute('data-node-id')));
  await page.getByRole('button', { name: '将当前排序应用到浏览器', exact: true }).click(); await idle();
  await waitAPI(page, async ({ id, order }) => JSON.stringify((await chrome.bookmarks.getChildren(id)).map(n => n.id)) === JSON.stringify(order), { id: root.id, order: visualOrder });
  await page.getByLabel('显示排序').selectOption('browser'); await page.locator('.toolbar-menu>summary').filter({ hasText: '整理工具' }).click();
  pass(`${name}: display sort makes no writes, explicit sort application matches displayed order`);

  // Drag a normal tree node into an empty main-area directory.
  const dragSource = await externalCreate(page, { parentId: root.id, title: '树节点拖动' });
  await externalCreate(page, { parentId: dragSource.id, title: '保留的子项', url: 'https://example.com/tree-drag' });
  await row(added.id).dblclick();
  const viewport = page.locator('.virtual-list');
  await page.locator(`[data-tree-id="${dragSource.id}"]`).dragTo(viewport, { targetPosition: { x: 8, y: 240 } });
  await waitAPI(page, async ({ id, parent }) => (await chrome.bookmarks.get(id))[0].parentId === parent, { id: dragSource.id, parent: added.id }); await idle();
  // Bottom breadcrumb accepts a dropped bookmark and preserves node ID.
  await row(b.id).dragTo(page.locator('.path-bar button').filter({ hasText: 'Finder 验收' }));
  await waitAPI(page, async ({ id, parent }) => (await chrome.bookmarks.get(id))[0].parentId === parent, { id: b.id, parent: root.id }); await idle();
  pass(`${name}: tree node drag source, background destination and breadcrumb drop`);

  // Native drag hovering navigates after 600 ms, allowing drop inside the new view.
  await selectFolder('Finder 验收'); await row(b.id).waitFor();
  const start = await row(b.id).boundingBox(); const target = await row(destination.id).boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + 40); await page.mouse.down(); await page.mouse.move(start.x + start.width / 2 + 12, start.y + 40, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + 40, { steps: 10 });
  for (let i = 0; i < 3; i++) { await page.waitForTimeout(40); await page.mouse.move(target.x + target.width / 2 + i, target.y + 40); }
  await page.waitForTimeout(650);
  await page.waitForFunction(() => document.querySelector('.directory-title')?.textContent === '目标空目录');
  const destViewport = await viewport.boundingBox(); await page.mouse.move(destViewport.x + 8, destViewport.y + 300, { steps: 4 }); await page.mouse.up();
  await waitAPI(page, async ({ id, parent }) => (await chrome.bookmarks.get(id))[0].parentId === parent, { id: b.id, parent: destination.id }); await idle();
  pass(`${name}: drag-hover navigation and drop after entering a folder`);

  // External deletion falls back to the nearest usable ancestor.
  await selectFolder('Finder 验收'); await row(added.id).dblclick();
  await page.evaluate(id => chrome.bookmarks.removeTree(id), added.id);
  await page.waitForFunction(() => document.querySelector('.directory-title')?.textContent === 'Finder 验收');
  await page.screenshot({ path: join(output, `${name.toLowerCase()}-grid-navigation.png`) });
  pass(`${name}: externally removed current directory falls back to surviving ancestor`);

  // Dashboard combines scoped filters, explicit duplicate preview, and returns to preserved filter state.
  await page.getByRole('button', { name: '数据看板', exact: true }).click();
  await page.getByLabel('看板目录范围').selectOption(root.id); await page.getByLabel('域名筛选').fill('example.com'); await page.getByLabel('重复筛选').selectOption('yes');
  await page.getByLabel('类型筛选').selectOption('bookmark'); await page.getByLabel('高级搜索').fill('nested A');
  await page.waitForFunction(() => document.querySelectorAll('.bookmark-row').length === 2);
  await page.getByRole('button', { name: '重复处理预览', exact: true }).click();
  const preview = page.getByRole('dialog'); assert((await preview.innerText()).includes('将回收 1 项'));
  await preview.getByRole('button', { name: '取消', exact: true }).click();
  const originalResult = row(a.id); await originalResult.getByRole('button', { name: '在书签管理器中显示', exact: true }).click();
  await row(a.id).waitFor(); assert.equal(await row(a.id).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: '数据看板', exact: true }).click();
  assert.equal(await page.getByLabel('看板目录范围').inputValue(), root.id); assert.equal(await page.getByLabel('域名筛选').inputValue(), 'example.com'); assert.equal(await page.getByLabel('重复筛选').inputValue(), 'yes');
  await page.waitForFunction(() => { const el = document.querySelector('.virtual-list'); return el && el.scrollWidth === el.clientWidth; });
  await row(a.id).click();
  await page.screenshot({ path: join(output, `${name.toLowerCase()}-dashboard.png`) });
  await page.getByRole('button', { name: '重复处理预览', exact: true }).click(); await page.getByRole('button', { name: '确认回收列出的副本', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.bookmark-row').length === 0); await idle();
  const original = await node(page, a.id); assert.equal(original.parentId, nested.id);
  assert.equal((await node(page, copied.id)).parentId, destination.id);
  await page.getByRole('button', { name: '书签管理器', exact: true }).click();
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  pass(`${name}: combined dashboard scope, duplicate confirmation and locate-return state`);
}

export async function gridPerformance({ page, name, pass, output }) {
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await page.locator('.virtual-list').evaluate(el => { el.scrollTop = 4231; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.getByRole('button', { name: '上一级', exact: true }).click(); await page.getByRole('button', { name: '后退', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.virtual-list')?.scrollTop === 4231);
  await page.locator('.virtual-list').evaluate(el => { el.scrollTop = 0; });
  pass(`${name}: back navigation restores exact scroll offset within a row`);
  await page.getByRole('button', { name: '图标视图', exact: true }).click();
  await page.waitForSelector('.grid-view');
  const rendered = await page.locator('.bookmark-row').count(); assert(rendered < 150);
  const el = page.locator('.virtual-list'); const box = await el.boundingBox();
  await page.mouse.move(box.x + 3, box.y + 3); await page.mouse.down(); await page.mouse.move(box.x + box.width - 12, box.y + box.height - 4, { steps: 10 });
  await page.waitForTimeout(1600); await page.mouse.up();
  const selectedText = await page.locator('.selection-actions').innerText(); const count = Number(selectedText.match(/已选择 (\d+) 项/)?.[1] ?? 0);
  assert(count > rendered, `Marquee selected ${count}, initial rendered ${rendered}`);
  assert((await el.evaluate(el => el.scrollTop)) > 500);
  const beforeSwitch = await page.locator('.bookmark-row').evaluateAll(ns => ns.find(n => n.getBoundingClientRect().top >= document.querySelector('.virtual-list').getBoundingClientRect().top)?.getAttribute('data-node-id'));
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  assert((await el.evaluate(el => el.scrollTop)) > 500); assert.equal(Number((await page.locator('.selection-actions').innerText()).match(/已选择 (\d+) 项/)?.[1]), count);
  await page.getByRole('button', { name: '图标视图', exact: true }).click(); assert((await el.evaluate(el => el.scrollTop)) > 500);
  await page.getByLabel('搜索书签', { exact: true }).fill('性能测试 09999'); await page.waitForFunction(() => document.querySelectorAll('.bookmark-row').length === 1);
  await page.getByLabel('搜索书签', { exact: true }).fill('');
  await page.screenshot({ path: join(output, `${name.toLowerCase()}-10000-grid.png`) });
  await page.reload(); await page.waitForSelector('.grid-view'); await page.waitForFunction(() => document.querySelector('.directory-title')?.textContent === '10,000 书签性能测试');
  pass(`${name}: 10,000 virtual grid, marquee across offscreen items, edge scrolling, view position and reload preferences`, `rendered=${rendered}, marquee=${count}, anchor=${beforeSwitch}`);
}
