import type { CheckJob, CheckResult, NodeMetadata, OperationRecord, Snapshot, SourceFile } from './types';
export interface Tables { operations: OperationRecord; metadata: NodeMetadata; sources: SourceFile; snapshots: Snapshot; results: CheckResult; jobs: CheckJob; kv: { id: string; value: unknown } }
export type Table = keyof Tables;
let opening: Promise<IDBDatabase> | undefined;
export function database(): Promise<IDBDatabase> {
  return opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('bookmarker', 1);
    request.onupgradeneeded = () => { for (const name of ['operations', 'metadata', 'sources', 'snapshots', 'results', 'jobs', 'kv']) request.result.createObjectStore(name, { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => { opening = undefined; reject(request.error); };
  });
}
export async function get<K extends Table>(table: K, id: string): Promise<Tables[K] | undefined> {
  const db = await database(); return new Promise((resolve, reject) => { const r = db.transaction(table).objectStore(table).get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
export async function all<K extends Table>(table: K): Promise<Tables[K][]> {
  const db = await database(); return new Promise((resolve, reject) => { const r = db.transaction(table).objectStore(table).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
export async function put<K extends Table>(table: K, value: Tables[K]): Promise<void> { await write([[table, value]]); }
export async function write(entries: [Table, Tables[Table]][]): Promise<void> {
  if (!entries.length) return;
  const db = await database(); await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...new Set(entries.map(([table]) => table))], 'readwrite');
    for (const [table, value] of entries) tx.objectStore(table).put(value);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export async function remove(table: Table, id: string): Promise<void> {
  const db = await database(); await new Promise<void>((resolve, reject) => { const tx = db.transaction(table, 'readwrite'); tx.objectStore(table).delete(id); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
}
export const uid = () => crypto.randomUUID();
export async function timestamp(): Promise<number> {
  const last = await get('kv', 'logical-time'); const value = Math.max(Date.now(), Number(last?.value ?? 0) + 1);
  await put('kv', { id: 'logical-time', value }); return value;
}
export async function profileId(): Promise<string> {
  const saved = await get('kv', 'profile'); if (saved) return saved.value as string;
  const value = uid(); await put('kv', { id: 'profile', value }); return value;
}
