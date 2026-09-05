import type { BrowserNode } from '../src/types';
export class MockBookmarks {
  tree: BrowserNode[] = [{ id: 'root-x', title: '', syncing: false, children: [
    { id: 'bar-local', parentId: 'root-x', index: 0, title: '书签栏', folderType: 'bookmarks-bar', syncing: false, children: [] },
    { id: 'bar-account', parentId: 'root-x', index: 1, title: '账号书签栏', folderType: 'bookmarks-bar', syncing: true, children: [] },
    { id: 'policy', parentId: 'root-x', index: 2, title: '企业书签', folderType: 'managed', unmodifiable: 'managed', syncing: false, children: [{ id: 'policy-link', title: '政策', url: 'https://policy.example/', parentId: 'policy', index: 0, syncing: false }] },
  ] }];
  sequence = 0; failTitle?: string;
  private node(id: string): BrowserNode { const queue = [...this.tree]; while (queue.length) { const n = queue.pop()!; if (n.id === id) return n; queue.push(...n.children ?? []); } throw new Error(`Can't find bookmark: ${id}`); }
  private clean(n: BrowserNode): BrowserNode { const { children, ...rest } = n; return structuredClone(rest); }
  private reindex(id: string) { this.node(id).children?.forEach((n, i) => { n.index = i; }); }
  getTree = async () => structuredClone(this.tree);
  get = async (id: string | string[]) => (Array.isArray(id) ? id : [id]).map(i => this.clean(this.node(i)));
  getSubTree = async (id: string) => [structuredClone(this.node(id))];
  getChildren = async (id: string) => (this.node(id).children ?? []).map(n => this.clean(n));
  create = async (details: { parentId?: string; title?: string; url?: string; index?: number }): Promise<BrowserNode> => {
    if (details.title === this.failTitle) throw new Error('Injected create failure');
    const parent = this.node(details.parentId!); if (parent.url) throw new Error('Not folder');
    const n: BrowserNode = { id: `node-${++this.sequence}`, title: details.title ?? '', parentId: parent.id, dateAdded: Date.now(), syncing: parent.syncing, ...(details.url !== undefined ? { url: new URL(details.url).href } : { children: [] }) };
    parent.children ??= []; parent.children.splice(details.index ?? parent.children.length, 0, n); this.reindex(parent.id); return this.clean(n);
  };
  update = async (id: string, change: { title?: string; url?: string }) => { const n = this.node(id); if (this.failTitle !== undefined && change.title === this.failTitle) throw new Error('Injected update failure'); if (change.title !== undefined) n.title = change.title; if (change.url !== undefined) n.url = new URL(change.url).href; return this.clean(n); };
  move = async (id: string, dest: { parentId?: string; index?: number }) => {
    const n = this.node(id); const old = this.node(n.parentId!); const target = this.node(dest.parentId ?? n.parentId!);
    let index = dest.index ?? target.children?.length ?? 0;
    if (old.id === target.id && (n.index ?? 0) < index) index--;
    old.children = old.children!.filter(c => c.id !== id); this.reindex(old.id); target.children ??= [];
    target.children.splice(Math.min(index, target.children.length), 0, n); n.parentId = target.id; this.reindex(target.id); return this.clean(n);
  };
  removeTree = async (id: string) => { const n = this.node(id); const p = this.node(n.parentId!); p.children = p.children!.filter(c => c.id !== id); this.reindex(p.id); };
  asApi() { return this as unknown as typeof chrome.bookmarks; }
}
