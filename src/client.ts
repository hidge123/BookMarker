import type { Message, Reply } from './types';
export const isExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
export async function request<T>(message: Message): Promise<T> {
  if (!isExtension) throw new Error('请在 Chrome 或 Edge 中加载 dist 扩展目录后使用');
  const response = await chrome.runtime.sendMessage(message) as Reply<T>;
  if (!response) throw new Error('后台未响应，请在扩展管理页重新加载后重试');
  if (!response.ok) throw new Error(response.error); return response.data;
}
