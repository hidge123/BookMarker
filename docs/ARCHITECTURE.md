# 实现架构与边界

## 扩展与权限

Manifest V3，Service Worker ES module，React/TypeScript 管理页面，Vite 多入口构建。页面资源全部打包在扩展内，不远程加载字体、图标或脚本，没有内容脚本、web accessible resources 或本机服务。

固定根目录、同种类型的多个账号/本地区域由实际书签树和 `folderType`、`unmodifiable`、`syncing` 判断，不硬编码浏览器根 ID。子孙继承受管理只读限制。依据 [Chrome bookmarks API](https://developer.chrome.com/docs/extensions/reference/api/bookmarks)。

## 持久化

IndexedDB `bookmarker` v1：`operations`、`metadata`、`sources`、`snapshots`、`results`、`jobs`、`kv`。`chrome.storage.local` 只保存检测设置；不使用 `storage.sync`。数据会随扩展卸载清除，参见 [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage)。

每个配置有随机 profile ID。操作和快照使用持久化单调逻辑时间，消除同毫秒操作排序的不确定性。所有浏览器节点以真实 API 返回值为准；原始 URL 输入另存元数据。

## 修改流程

1. 页面发送带预期节点字段的类型化消息。大文件预览先进入共享 IndexedDB 暂存区，消息只传暂存 ID。
2. 后台串行规划操作、识别受保护节点、建立引用依赖，必要时先快照。
3. 逐步验证标题、URL、父目录、索引；移动/删除目录还校验子树摘要。只发送实际要变更的字段。
4. 持久化 `running` 意图和修改前信息，再调用 `chrome.bookmarks`。
5. 保存 API 返回的实际结果，使用同一 IndexedDB 事务确认操作进度与节点元数据。
6. 每批至多 25 步或约 8 秒让出执行。变更事件向所有工作台发刷新通知，列表按需渲染。

一次只接受一个尚未完成的修改计划，避免在半完成批次中拍摄不清晰的版本边界。计划内每步单独保存完成/失败状态；独立步骤失败不声称整批回滚。

Chromium 书签 API 不提供 compare-and-swap 或多节点事务。提交前的核对能识别已经发生的外部修改，但核对与实际 API 调用之间仍存在极小的竞争窗口，不能描述为数据库级原子隔离。

## 恢复与版本

后台启动时，重新核对持久化的运行中步骤。更新与移动仅在符合修改前或精确目标状态时继续/确认；原地排序也记录有效目标索引。带目录摘要的移动不会吸收后台中断期间的外部子树变化。

新建在浏览器已完成但日志尚未获得 ID 的窗口内不可可靠归因。此时暂停并让用户关联真实节点或跳过；不通过同名匹配自动重建。未知节点不会成为永久删除目标。

撤销、重做、回滚都生成新的操作记录。撤销创建将拥有的节点移动到回收站，避免破坏 ID；存在不属于该创建操作的子节点时报告冲突。回滚逆序构建补偿操作而非用快照整库替换。永久删除不可恢复 API 未公开的数据。

导入备份分配新 ID；完成后把归档中的回收站位置映射为新 ID 和当前区域。旧操作历史、旧快照和旧检测结果作为源 ZIP 原件保留，不启用跨配置 ID 操作。

## 检测调度

网络队列与修改队列独立。检测队列以固定 `jobId:nodeId` 保存结果，中断重测不会产生多个同任务结果。运行中的 item 重启后回到 pending；完成项跳过；取消状态持久化。

`webRequest` 在可用时尽早注册，只关联 initiator 为本扩展、tabId 为 -1、URL/方法匹配活动检测的请求 ID。重定向沿 requestId 记录。fetch 拒绝与错误事件可能有调度差异，最多等待 150 ms 获取对应原始错误，然后明确降级为无详情。

按批选择最多总并发项，每主机不超过 2。HEAD/GET 每次独立超时；GET 使用 Range 和限定 BYOB 缓冲，64 KiB 后取消。凭据策略为 `omit`，referrerPolicy 为 `no-referrer`，不缓存。

依靠消息、onStartup 和 30 秒 alarms 续跑，不以永久存活的 Service Worker 为前提。短定时器仅加快仍然活跃时的下批执行，持久队列和 alarms 才是恢复依据。参见 [Service Worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[跨域请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)。

## 性能与后续空间

列表固定行高 62px，使用 ResizeObserver、可见范围与上下预留行渲染；搜索在内存书签索引上进行，React deferred query 降低输入阻塞。当前一步一次保存操作记录，超大型导入时完整步骤日志的重写成本仍然随批次长度增长；如需长期处理十万级导入，可将步骤迁移到单独对象仓库。此版本已对一万条真实测试书签验证虚拟列表和搜索，未宣称十万级批次吞吐验收。

日志、手动/操作快照持续增长，磁盘限制仍存在。`unlimitedStorage` 不等于无限硬盘。未实现云同步、压缩 Firefox jsonlz4、商店发布或无痕配置管理。
