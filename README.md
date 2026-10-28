# 小安 soc-agent · 生产环境安全运维智能体

> 开源项目：**github.com/hughliat/soc-agent**。中文名「小安」，英文名 **soc-agent**。
> 包名 `soc-agent`，命令 `argus` / `soc`（两个都可用）。

<img src="assets/logo.png" alt="小安 soc-agent" width="420">


装在这台服务器上的**故障诊断助手**。你说"服务器有问题"，它自己翻本机日志、查知识库、必要时联网查报错含义，然后给你**问题清单 + 根因 + 解决措施 + 验收方法**。

只读、不执行修复。给方案，人来做。

## 它能干什么

```
❯ 这台服务器有什么问题

● 扫本机日志…
  [diagnose_logs] 扫了 15 个日志 / 2953 行
● 查知识库…
  [kb_lookup] 命中「磁盘满」「OOM」速查表
● 精读上下文…
  [read_log] /var/log/fsck_apfs_error.log

结论：3 个要处理的问题，最要紧的是 xxx

1. 〔critical〕磁盘 IO 错误
   - 证据：/var/log/kernel.log:142  "EXT4-fs error (device sda1)"
   - 根因：事实（内核报错）；推断（扇区重映射已达阈值）
   - 措施：① 立即停止写操作 ② smartctl -a /dev/sda ③ 备份后换盘
   - 验收：SMART 无新增错误，阵列 healthy
```

## 能力清单

> 25 个工具（23 自有 + 2 框架自带联网，含 1 个记忆沉淀） + 8 个界面命令 + 3 类定时任务。完整清单见 `docs/07-部署说明.html` 第六章。

| 工具 | 干什么 |
|---|---|
| `diagnose_logs` | **首选入口**：自动挑日志 → 匹配 21 类故障模式 → 给问题与措施 |
| `ls_logs` | 列出本机有哪些日志可看（日志地图，不知道路径就用它） |
| `read_log` | 读指定日志片段（带关键字过滤、支持 gzip） |
| `kb_lookup` | 查内置知识库（纪律/专家/技能/速查/本机记忆） |
| `query_ansible` / `query_edr` / `query_all` / `correlate` / `explain_events` | 查变更与终端告警的跨源关联 |
| `web_search` / `web_fetch` | 联网查报错含义、已知缺陷、官方处置建议 |

## 内置 21 类故障模式

磁盘满 / inode 耗尽 / OOM / 服务启动失败 / 端口冲突 / 连接被拒 / 超时 / 认证失败 /
权限不足 / fd 耗尽 / 磁盘 IO 错误 / RAID 降级 / 证书过期 / DNS 失败 / 日志暴涨 /
段错误 / 时间漂移 / 数据库连接 / 慢查询 / CPU 高负载 / 扫描探测

每条规则自带：识别特征 → 首查命令 → 常见根因 → 处置步骤 → 验收标准。

## 装

> **内网生产环境**：在线安装需要访问 npm 源。无外网时用离线包——
> 在与目标同平台的机器上 `sh tools/make-offline.sh` 生成，拷到目标机 `./install-offline.sh`。
> 详见 `docs/07-部署说明.html` 第十一章。

```sh
./install.sh dsh-tui      # 默认；装进 dst 用的那个 profile
./install.sh headless     # 无头（定时任务用）
```

只做三件事：拷进 profile 的 `node_modules`、挂进 `cordis.patch.yml`、配身份提示词。不改 dsh 本体。

## 用

```sh
dst
```

进去直接说「服务器有什么问题」「机器最近很卡」「磁盘满了怎么办」。

## 安全边界

**能做的**：读本机日志、查知识库、联网查资料、读已入库的变更/告警事件。
**不能做的**：执行命令、改配置、重启服务、写文件、派生代理、装插件、连 MCP。

### 四层防线（实测有效）

| 层 | 机制 | 作用 |
|---|---|---|
| 1（主） | `restrict({allow})` on agent scope | 模型可见工具收敛到白名单 |
| 2 | `guard()` 单调守卫 | 兜住 restrict 管不到的 own-layer 工具 |
| 3 | **沙箱锁死** | `read-only` + `approval: never`，权限表只留 `soc-readonly` |
| 4 | cordis `disabled` | bash/pwsh/fs/subagent/workflow/plugin-manager/mcp 不加载 |

### 工具数（实测，不是估算）

| 形态 | 模型可见 | 真正可用 | 差额 |
|---|---|---|---|
| headless | 11 | **11** | — |
| dst (TUI) | 12 | **11** | `subagent` 可见但调用必被拒 |

`subagent` 是 dsh-tui preset 往 agent 自己层注册的（`toolName: subagent`），
`restrict` 按设计只过滤继承层、不管 own-layer，所以它看得见；由 `guard` 兜住。
实测拒绝信息：`soc-agent 只读策略：禁止调用工具「subagent」`。

### 权限档位：UI 里选不到危险选项

原状：dst 能切「工作区读写 / 完全访问」三档，还能切「标准/梁神模式」，Shift+Tab 在
default/plan/full 间循环 —— **等于把安全模型交给使用者自己解**。

现在（`cordis.patch.yml` 锁死）：

- `permission.presets` 只保留 `soc-readonly`，`workspace-write` / `danger-full-access`
  **从表里删除**，UI 没有选项可点
- `sandbox-policy.mode` 硬编码 `read-only`（不再读 `DSH_PERMISSION_MODE`）
- `approval.policy` 硬编码 `never`（需审批的操作直接拒，不静默挂起）
- `dsh-tui.preset` 硬编码 `standard`（不读 `DSH_TUI_PRESET`，盖过持久化偏好）
- `modes` 只声明一个 `readonly`，Shift+Tab 没有别的档可切

**注意**：`install.sh` 会幂等补齐这段配置 —— 老版本升级上来也会自动修正。

### 封禁 dsh-tui 的多余入口（`tools/patch-dsh-tui.sh`）

启动页那几个入口是 dsh-tui **硬编码的纯函数返回值**，没有配置开关，插件层关不掉，
只能改源码。补丁改三处（都只改返回值，不动逻辑）：

| 改哪里 | 改什么 | 为什么 |
|---|---|---|
| `launchpadActions.js` | 启动页只返回「帮助」 | 摘掉「会话与工作区 / 设置 / 有新版本 / 后台任务 / 投喂 Star」 |
| `Launchpad.js` | 不渲染 preset / permission 两段 | `/preset` 已被 config 钉死、权限只有只读一档，显示只会让人以为能改 |
| `update.js` | `checkForTuiUpdate()` 直接返回 `undefined` | 查版本会走 npm registry，**这是外网出口**，内网产品不该有 |

```sh
sh tools/patch-dsh-tui.sh            # 打补丁（幂等，已打则跳过）
sh tools/patch-dsh-tui.sh --revert   # 回滚
```

两个要点：

1. **会自动探测所有 dsh-tui 副本**。dsh 实际加载的是 `~/.dsh/profiles/*/node_modules/` 里那份，
   不是全局 `nvm` 那份 —— 只改全局等于没改（这个坑踩过）。
2. **dsh-tui 升级后补丁丢失**，重跑脚本即可。每次改动前自动备份为 `*.soc-agent-backup`，
   打完还会 `node --check` 校验语法，语法错自动回滚该文件。

结果：启动页底部从 `deepseek-flash · Max · standard · soc-readonly` 收成 `deepseek-flash · Max`。

## 知识库（7 库结构）

```
knowledge/
├── AGENTS.md              纪律层：行为规范与红线
├── experts/               专家层：linux-ops / network
├── skills/                技能层：诊断操作手册
├── kb/                    知识层：常见故障速查
└── memory/                记忆层：本机基线（部署后填一次）
```

模型通过 `kb_lookup` 检索，不用把全文背进提示词。

## 审计

每次工具调用写 `~/.dsh/soc-agent/audit/audit-YYYY-MM-DD.jsonl`，带 sha256 哈希链（`prevHash` + `alg` 版本号）。

- 篡改任何字段（含嵌套的工具参数、事件 ID）都会断链
- 跨天自动续链，不会误报
- 算法升级按记录自身版本校验，历史链不失效

## 已知限制

- **内网模型端点未定**：当前用 DeepSeek 云端 key 联调，交付前必须切内网并全量复测
- 天擎 / OneSEC 适配器无真实样本，标 `verified: false`
- 10 万行日志压测未做
- 数据库只读连接器未接真实驱动（SELECT-only 拦截已就位）
- TUI 的 71 个 slash 命令属 dsh-tui 内建 UI，无法通过插件关闭；有风险的三个入口（`/plugin` `/mcp` `/skill`）对应插件已被 disabled

## 文档（Wiki）

离线可读，直接用浏览器打开 `docs/wiki/index.html`：

| 页面 | 内容 |
|---|---|
| `docs/wiki/index.html` | 总览：是什么、能力边界、安全模型、5 分钟上手 |
| `docs/wiki/architecture.html` | 总体方案：分层架构、数据流、三层只读防线、部署拓扑 |
| `docs/wiki/prd.html` | 产品需求：用户与场景、功能需求、非功能需求、验收标准 |
| `docs/wiki/design.html` | 开发设计：模块划分、事件模型、关键算法、测试策略 |

## 目录

```
lib/index.js              服务端：工具注册 + 白名单 + 守卫 + 提示词 + 审计
src/core/logdiscover.js   本机日志发现（白名单目录 + 敏感路径拦截）
src/core/diagnose.js      21 类故障规则库（带措施与验收）
src/core/kb.js            知识库检索
src/core/model.js         统一事件模型
src/core/store.js         只追加索引 + 幂等
src/core/analyze.js       归类 / 关联 / 聚合
src/core/audit.js         哈希链审计（带算法版本）
src/core/adapters/        ansible / edr / db-readonly
bin/ingest.js             日志入库 CLI
knowledge/                7 库
docs/wiki/                Wiki（总体方案 / PRD / 开发设计，离线 HTML）
tests/run.js              单测（92 条，node tests/run.js）
tests/fixtures/           Ansible 三种格式的脱敏夹具（单测自带，不依赖外部目录）
```
