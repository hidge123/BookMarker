export type BrowserNode = chrome.bookmarks.BookmarkTreeNode;
export interface BookmarkRecord {
  id: string; parentId?: string; index: number; title: string; url?: string;
  dateAdded?: number; dateGroupModified?: number; dateLastUsed?: number;
  folderType?: string; syncing?: boolean; readOnly: boolean; fixed: boolean;
  regionId: string; path: string[]; children: string[]; inTrash: boolean;
  metadataRef?: string;
}
export interface Expected { id: string; title: string; url?: string; parentId?: string; index: number; treeHash?: string }
export interface NodeMetadata {
  id: string; sourceId?: string; sourcePath?: string; originalInput?: string;
  raw?: unknown; trash?: { parentId: string; index: number; regionId: string; at: number };
  recycleRegion?: string;
}
export interface ImportNode { key: string; title: string; url?: string; children?: ImportNode[]; raw?: unknown; sourcePath?: string; metadata?: NodeMetadata }
export interface SourceFile { id: string; name: string; bytes: number[]; sha256: string; format: string; importedAt: number }
export interface ParsedImport { format: string; nodes: ImportNode[]; warnings: string[]; source: SourceFile }
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'conflict' | 'needs-review' | 'skipped';
export interface OperationStep {
  id: string; kind: 'create' | 'update' | 'move' | 'remove'; nodeId?: string;
  parentId?: string; parentRef?: string; index?: number; title?: string; url?: string;
  beforeId?: string; atEnd?: boolean;
  expected?: Expected; before?: Expected; after?: Expected; state: StepState;
  metadata?: Partial<NodeMetadata>; metadataBefore?: NodeMetadata; metadataAfter?: NodeMetadata;
  error?: string; createdId?: string; startedAt?: number; completedAt?: number;
  irreversible?: boolean;
  allowedDescendantIds?: string[];
  systemRecycle?: boolean; importKey?: string; importedMetadata?: NodeMetadata; importRegionId?: string;
}
export interface OperationRecord {
  id: string; label: string; createdAt: number; completedAt?: number;
  status: 'queued' | 'running' | 'done' | 'partial' | 'needs-review' | 'cancelled';
  steps: OperationStep[]; profileId: string; undoOf?: string; redoOf?: string;
  reverting?: boolean;
  warnings: string[];
}
export interface Snapshot { id: string; createdAt: number; label: string; kind: 'daily' | 'automatic' | 'manual'; profileId: string; tree: BrowserNode[]; metadata: NodeMetadata[]; operationIds: string[] }
export type CheckStatus = 'ok' | 'http-error' | 'restricted' | 'network-error' | 'unknown' | 'skipped';
export const STATUS_LABELS: Record<CheckStatus | 'stale' | 'unchecked', string> = { ok: '正常', 'http-error': '站点响应错误', restricted: '访问受限', 'network-error': '连接异常', unknown: '无法确认', skipped: '已跳过', stale: '结果已过期', unchecked: '未检测' };
export interface CheckResult {
  id: string; jobId: string; nodeId: string; url: string; status: CheckStatus;
  checkedAt: number; durationMs: number; finalUrl?: string; httpStatus?: number;
  rawError?: string; reason?: string; redirects: { from: string; to: string; status: number }[];
  method?: string; bytesRead?: number; stale?: boolean;
}
export interface CheckItem { nodeId: string; url: string; state: 'pending' | 'running' | 'done' }
export interface CheckJob {
  id: string; createdAt: number; completedAt?: number; scope: string;
  status: 'queued' | 'running' | 'done' | 'cancelled'; items: CheckItem[];
  allowPrivate: boolean; permissionGranted: boolean;
}
export interface Settings { allowPrivate: boolean; concurrency: number; perHost: number; timeoutMs: number }
export const DEFAULT_SETTINGS: Settings = { allowPrivate: false, concurrency: 6, perHost: 2, timeoutMs: 12000 };
export interface AppState {
  tree: BrowserNode[]; metadata: NodeMetadata[]; operations: OperationRecord[];
  snapshots: Omit<Snapshot, 'tree' | 'metadata'>[]; results: CheckResult[]; jobs: CheckJob[];
  settings: Settings; profileId: string;
}
export type EditCommand =
  | { kind: 'create'; parentId: string; title: string; url?: string }
  | { kind: 'update'; changes: { expected: Expected; title?: string; url?: string }[] }
  | { kind: 'move'; nodes: Expected[]; parentId: string; index?: number }
  | { kind: 'trash' | 'restore' | 'purge'; nodes: Expected[]; confirmed?: boolean }
  | { kind: 'import'; parentId: string; folderTitle: string; parsed: ParsedImport }
  | { kind: 'undo' | 'redo'; operationId: string }
  | { kind: 'rollback'; snapshotId: string };
export type Message =
  | { type: 'state' }
  | { type: 'edit'; command: EditCommand }
  | { type: 'snapshot'; label: string }
  | { type: 'backup' }
  | { type: 'backup-stage' }
  | { type: 'import-stage'; stageId: string; parentId: string; folderTitle: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'check'; nodeIds: string[]; scope: string }
  | { type: 'cancel-check'; jobId: string }
  | { type: 'resume' }
  | { type: 'resolve'; operationId: string; stepId: string; action: 'skip' | 'adopt'; nodeId?: string };
export interface BackupData {
  format: 'bookmarker-project'; version: 1; exportedAt: number; profileId: string;
  tree: BrowserNode[]; metadata: NodeMetadata[]; operations: OperationRecord[];
  snapshots: Snapshot[]; sources: SourceFile[]; results: CheckResult[]; jobs: CheckJob[]; settings: Settings;
}
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
