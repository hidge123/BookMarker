# 验收记录

所有浏览器测试使用独立临时配置和人工创建的数据，不读取个人书签。本地受控 HTTP 服务只绑定 `127.0.0.1`。测试脚本与机器可读报告随源码交付。

最终运行：2026-09-06，版本 **1.1.0**。84 项单元测试（原 63 项基线 + 21 项新增）、TypeScript 严格类型检查、65 项集成检查、生产构建、ZIP CRC 和 SHA-256 校验全部通过。实际浏览器为 Chrome 152.0.7977.82、Edge 152.0.4191.66。

Chrome 与 Edge 均在独立配置内创建 10,000 条书签，验证列表、图标、搜索、全选、屏幕外框选、边缘滚动、双视图切换与重启偏好恢复。最终测量：

| 浏览器 / 检查 | 实测 |
| --- | --- |
| Chrome: 10,000 bookmark virtual list and search | rendered=27, search=9ms, fixture=711ms |
| Chrome: 10,000 selection and batch move preview | 73ms |
| Chrome: 10,000 virtual grid, marquee across offscreen items, edge scrolling, view position and reload preferences | rendered=126, marquee=180, anchor=193 |
| Edge: 10,000 bookmark virtual list and search | rendered=27, search=14ms, fixture=804ms |
| Edge: 10,000 selection and batch move preview | 74ms |
| Edge: 10,000 virtual grid, marquee across offscreen items, edge scrolling, view position and reload preferences | rendered=126, marquee=171, anchor=195 |

Chrome / Edge 框选分别选择 180 / 171 项，均超过当时渲染的 126 项；前进/后退另验证恢复到 4,231px 的精确行内偏移。上述数字仅代表此次本机测试，非所有硬件的性能保证。

## 自动化

| 检查 | 覆盖 |
| --- | --- |
| TypeScript 严格类型检查 | 页面、后台、格式、存储与测试代码 |
| 84 项单元测试 | 任意根 ID、账号区、受管理继承、外部冲突、回收恢复、撤销重做、版本回滚、原件和哈希、快照保留、各格式、网络分类、超时与字节限制；新增子树复制、来源冲突、中断核对、锚点插入、剪贴板部分完成、范围过滤、祖先回退与完整布局框选 |
| 真实 Chrome / Edge 扩展集成 | 默认图标/列表属性、空白区新建、F2 保存/取消、多选、子树复制、剪切/粘贴、元数据与 ID、拖拽排序、树/路径拖放、600ms 悬停导航、输入框快捷键、外部同步及固定根保护 |
| 真实后台中断 | DevTools 停止 Service Worker，核对未确认的新建，人工关联后不重复创建 |
| 浏览器重启 | 操作日志、元数据与检测未完成队列持久保留并恢复 |
| 文件导入/完整备份 | 确认前无浏览器变更，HTML 中文与特殊字符，原始字节一致，ZIP 下载、预览和新 ID 恢复 |
| 统一数据看板 | 目录、关键词、域名、类型及重复组合筛选，明确回收预览，定位后恢复筛选，所有结果列无横向溢出 |
| 10,000 条书签 | 两种浏览器 API 创建夹具，虚拟列表/网格、搜索计时、屏幕外框选、边缘滚动和精确历史位置恢复 |
| 受控网络 | 2xx、404、410、401、403、429、503、HEAD 405→GET、302 跳转、真实连接错误、超时、取消、缺少权限、私网过滤、无 Cookie/认证头、同主机并发上限 |
| 生产包 | Vite 生产构建、MV3 清单、最小必需权限、图标与入口文件、ZIP 内容验证 |

最终实际浏览器版本、各项 PASS 和性能数字以 [`test-results/integration-report.json`](../test-results/integration-report.json) 为准。界面截图：[`chrome-grid.png`](../test-results/chrome-grid.png)、[`chrome-manager.png`](../test-results/chrome-manager.png)、[`chrome-dashboard.png`](../test-results/chrome-dashboard.png)、[`edge-grid.png`](../test-results/edge-grid.png)、[`edge-manager.png`](../test-results/edge-manager.png)、[`edge-dashboard.png`](../test-results/edge-dashboard.png)。一万条双视图、搜索、备份预览和目录导航截图一并保存在 `test-results/`。网络原始证据见 [`controlled-network-results.json`](../test-results/controlled-network-results.json)。

## 测试方法的边界

- 安装版本实际测试为 Chrome 152 / Edge 152，最低 Chromium 134 由 API 需求与清单声明确定，未在旧版本二进制上重新运行。
- 自动化的网络测试使用**临时副本**提前授予与发布版可选权限相同的权限，方便无头浏览器运行。正式 `dist/manifest.json` 始终保持按需权限，Chrome/Edge 均检查默认未授权时不请求网络、显示跳过。
- 操作系统上的首次可选权限授权/拒绝弹窗保留为人工安装检查；未将预授予夹具伪称为真实权限弹窗验收。
- 受管理书签由可控 API 夹具覆盖，没有修改本机企业策略来制造托管浏览器配置。
- 64 KiB 指应用读取量；浏览器底层可能提前接收或缓存更多网络字节。
- 一万条验收覆盖双视图、搜索、框选、边缘滚动、位置恢复和批量操作反馈；没有对十万级复制/导入吞吐量作保证。

## 复现

```sh
npm ci
npm run typecheck
npm test
npm run package
npm run test:integration
```

集成测试失败时返回非零退出码，并把错误写入 `integration-report.json`。`--chrome-only`、`--finder-only` 和 `--network-only` 仅用于开发时定向排查；最终报告使用不带参数的全量运行。
