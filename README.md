# dsh-perf-guard

**Zero-polling performance guard, reversible session cold-archiver, and on-demand storage doctor for DeepSeek Harness (DSH 0.2.x).**

面向 DeepSeek Harness（DSH 0.2.x）的**零后台轮询性能护航插件**：提供可逆会话冷热归档与标题离线搜索、按需存储体检、插件前后性能对比快照、纯 CSS 离屏渲染优化，以及可在设置页调参的会话流瘦身。

---

## 为什么做这个插件 / Why

重度使用 DSH 时，界面掉帧、输入发涩或内存飙高通常来自三层叠加：
1. **海量历史会话撑爆侧边栏**：`sessions/` 积压上千条历史会话，侧边栏全量渲染出数万 DOM 节点；
2. **单条超长会话首帧过重**：默认一次拉取 500 条消息与巨型工具定义 schema，造成主线程长任务阻塞；
3. **第三方插件存储小文件膨胀**：部分插件在 `storages/` 下堆积数万个小文件或高频重写大 JSON，平时无从察觉。

`dsh-perf-guard` 坚持 **零后台轮询、只移不删、零核心文件修改、与 `dsh-lag-guard` 自动和平共存**。

---

## 核心功能 / Features

在 DSH **设置 → 性能护航** 中一站式管理：

- **4 套一键预设（Presets）**：
  - **轻量无感**：纯 CSS 离屏优化 + 按需体检 + 手动归档（零数据流干预）；
  - **重度长会话**：流瘦身 + 挂机减负模式 + CSS 离屏优化 + 长驻提醒；
  - **海量历史档**：侧重 30 天+ 历史会话冷归档与离线标题搜索；
  - **插件排查档**：侧重存储膨胀体检与插件前后对比快照。
- **可逆会话冷热归档（Reversible Cold Archiver）**：
  - 按“早于 N 天 / 大于 N MB”先**预览清单**，确认后将旧会话原样移至 `$DSH_HOME/sessions-archive/`（**只移不删**）；
  - 自动跳过近期活跃会话（默认 10 分钟内有写入）与星标豁免项；
  - 自动读取 `session_projcache` 可读标题，支持**按标题/ID/工作区离线搜索**并随时**一键原位还原**。
- **按需性能体检（On-Demand Doctor）**：
  - 平时 **0 定时器、0 后台轮询**；点击「立即体检」扫描 `sessions/` 分布、`storages/` 膨胀目录及大体积附件/历史备份目录；
  - 每个异常目录旁提供 **「打开目录」**（严格限制在 `$DSH_HOME` 内，由用户自行决定清理）。
- **插件前后性能对比快照（Before/After Snapshots）**：
  - 增删或更新第三方插件前后各拍一张快照，自动计算 DOM 节点数、会话数与存储文件数增量（Δ）。
- **无侵入渲染减负**：
  - 纯 CSS `content-visibility: auto` 离屏跳过渲染 + 可选挂机减负模式（暂停过渡/动画）；
  - 可在 UI 调参的 `SessionEventStream` 流瘦身（不改落盘日志、不改模型上下文）；若检测到已安装 `dsh-lag-guard`（`Symbol.for("dsh-lag-guard.patched.v1")`），自动避让不重复包裹。

---

## 隔离环境实测数据 / Isolated Benchmark

在隔离 `DSH 0.2.2`（独立 `DSH_HOME` 与端口）打开同一条 **23.5 MB 真实长会话** 的实测对比：

| 指标 (Metric) | 纯 `0.2.2` 基线 | + `dsh-perf-guard` (`heavy`) | 变化 (Delta) |
|---|---:|---:|---:|
| 页面 DOM 节点数 | 10,711 | **4,917** | **-54.1%** |
| CDP 总节点数 | 16,231 | **7,450** | **-54.1%** |
| JS 堆内存 (JSHeapUsed) | 62.4 MB | **39.5 MB** | **-36.7%** |
| 打开阶段主线程 Long Task 总阻塞 | 566 ms (max 431 ms) | **287 ms (max 215 ms)** | **-49.3%** |
| 控制台报错数 (Console Errors) | 0 | **0** | **0** |

---

## 安装与卸载 / Install & Remove

### Desktop 版（桌面端）
```bash
dsh plugin --profile desktop add github:unifilitence/dsh-perf-guard
```

### Web 版
```bash
dsh plugin --profile web add github:unifilitence/dsh-perf-guard
```

安装后正常重启一次 DSH，打开 **设置 → 性能护航** 即可使用。

### 卸载 / Remove
```bash
dsh plugin --profile desktop remove dsh-perf-guard
```
*(已归档的会话完整保留在 `$DSH_HOME/sessions-archive/`，不会随卸载丢失。)*

---

## 安全红线 / Safety Guarantees

- **绝不修改** `app.asar`、`cordis.patch.yml`、`.credentials.yaml` 或其他插件的数据；
- 配置与归档索引仅写入独立目录 `$DSH_HOME/storages/dsh-perf-guard/`；
- 会话归档严格执行路径遍历校验与活跃会话保护，**只移不删**；
- 所有 Host Fetch 路由绑定 Cordis disposer，卸载干净；上游 API 若改名则自动静默降级，绝不阻塞启动。

---

## 开发与测试 / Development

```bash
npm test
```

## 致谢与协议 / Credits & License

- 流窗口裁剪思路参考并致谢 MIT 开源插件 [456erddgr/dsh-lag-guard](https://github.com/456erddgr/dsh-lag-guard)（本插件在检测到其已激活时自动避让共存）。
- Licensed under the [MIT License](./LICENSE).
