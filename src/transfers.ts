import * as db from './store';
import { request } from './client';
import type { BackupData, OperationRecord, ParsedImport } from './types';

// Keep original bytes out of Chrome's JSON runtime-message size limit.
export async function importTransfer(parentId: string, folderTitle: string, parsed: ParsedImport): Promise<OperationRecord> {
  const stageId = `import:${db.uid()}`;
  await db.put('kv', { id: stageId, value: parsed });
  try { return await request({ type: 'import-stage', stageId, parentId, folderTitle }); }
  finally { await db.remove('kv', stageId); }
}
export async function backupTransfer(): Promise<BackupData> {
  const { stageId } = await request<{ stageId: string }>({ type: 'backup-stage' });
  try { const data = await db.get('kv', stageId); if (!data) throw new Error('备份传输未完成，请重试'); return data.value as BackupData; }
  finally { await db.remove('kv', stageId); }
}
