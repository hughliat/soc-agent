#!/bin/sh
# 把 soc-agent 插件装进指定的 dsh profile。
#
# 用法：./install.sh [profile名]   默认 dsh-tui（即 dst 用的 profile）
#
# 只做两件事：把插件拷进 profile 的 node_modules、在 profile 的 cordis.patch.yml
# 里挂载。不改 dsh 本体、不联网。
#
# 幂等：重复执行不会重复 insert（不会重复注册工具），并会刷新插件内容。
#
# 注意：dsh 的 patch 文件是「顶层 YAML 数组」。空 profile 的默认内容是 `[]`，
# 往它后面直接追加 `- id: ...` 会得到 `[]` + 数组项 的畸形 YAML，启动即失败
# （2026-10-21 实际踩过）。所以这里区分「空数组占位」与「已有真实条目」两种情况。
set -eu

PROFILE="${1:-dsh-tui}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DEST="$DSH_HOME/profiles/$PROFILE/node_modules/soc-agent"
PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"

# ── 前置依赖：dsh 必须已安装 ──
# 本产品是 dsh 插件，不是独立程序。没装 dsh 就等于没装运行环境。
# 这一步必须挡在最前面：否则用户会装完 soc-agent 才发现跑不起来。
if ! command -v dsh >/dev/null 2>&1; then
  cat >&2 <<'MSG'
错误：找不到 dsh 命令。

  本产品是 dsh 的插件，不是独立程序 —— 必须先装 dsh。
  依赖链：Node.js ≥ 18  →  dsh CLI  →  dsh-tui 界面  →  soc-agent（本产品）

安装 dsh，三选一：
  1) 有外网：
       npm i -g @deepseek-ai/dsh

  2) 内网无外网（从同平台的联网机器拷全局包）：
       源机：  tar -czf dsh-global.tgz -C "$(npm root -g)" @deepseek-ai
       目标机：tar -xzf dsh-global.tgz -C "$(npm root -g)"
               dsh --version

  3) 详见部署说明「二、环境要求」与「十、离线部署」

装好后重跑：./install.sh <profile>
MSG
  exit 2
fi

if [ ! -d "$DSH_HOME/profiles/$PROFILE" ]; then
  cat >&2 <<MSG
错误：profile 不存在：$DSH_HOME/profiles/$PROFILE

  dsh 第一次运行时才会创建 profile 目录。请先执行一次：

      dsh --profile $PROFILE

  等它初始化完（首次可能需要下载界面组件，内网请改用离线包），
  退出后再重跑本脚本。

  若目标 profile 名不是 $PROFILE，请显式指定：./install.sh <profile名>
MSG
  exit 2
fi

# ── 1. 拷插件 ──
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$HERE/lib" "$HERE/src" "$HERE/bin" "$HERE/knowledge" "$HERE/tools" "$HERE/dsh.plugin.json" \
      "$HERE/package.json" "$HERE/cordis.patch.yml" "$HERE/README.md" "$DEST/"

# ── 2. 挂进 patch ──
# soc-agent 自己的 bundle patch（soc-agent/cordis.patch.yml）已含全部
# disabled 行；profile 层只需要把插件行 insert 进来。
# 已有 soc-agent：认为已挂过，不重复 insert（避免重复注册导致工具重名）。
# 安全配置块（沙箱锁死 + 权限表 + preset 钉死）可能因版本升级而缺失，
# 即使插件已挂载也必须补齐 —— 否则重装旧版本配置会把防线还原。
SECURITY_MARKER='soc-readonly'

if grep -q "name: soc-agent" "$PATCH" 2>/dev/null; then
  echo "patch 里已有 soc-agent，跳过挂载（插件内容已刷新）"
  if ! grep -q "$SECURITY_MARKER" "$PATCH" 2>/dev/null; then
    echo "检测到安全配置缺失，补齐沙箱锁死与权限表…"
    cat >> "$PATCH" <<'SOCSEC'

# ── 沙箱锁死：只读 + 拒绝一切需审批操作（install.sh 补齐）──
- id: sandbox-policy
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never
- id: permission
  config:
    presets:
      soc-readonly:
        sandbox: read-only
        approval: never
        name: soc-readonly
        description: 只读；写操作与提权请求一律拒绝。本产品的唯一权限档。
    defaultPreset: soc-readonly
SOCSEC
    if [ "$PROFILE" = "dsh-tui" ]; then
      cat >> "$PATCH" <<'SOCPM'

# ── 钉死 agent preset 与模式（install.sh 补齐）──
- id: dsh-tui
  config:
    provider: deepseek-official
    fullscreen: true
    terminalImages: true
    effort: high
    preset: standard
    modes:
      - id: readonly
        plan: false
        sandbox: read-only
        approval: never
SOCPM
    fi
    echo "已补齐安全配置"
  fi
else
  BLOCK='# ── soc-agent：安全运维智能体 ──
#
# 挂载插件本体。安全主防线（按 agent 的工具白名单）由插件在
# agent/created 时通过 agent.ctx.tools.restrict 实施，见 soc-agent/lib/index.js。
# 危险工具与外网能力的 disabled 行在 soc-agent 自己的 cordis.patch.yml 里，
# 不在此处重复 —— 两处维护容易漂移。
- insert:
    - id: soc-agent
      name: soc-agent

# ── 身份：关掉 dsh 内核自述，换成本产品人设 ──
# includeHarnessIdentity:false 去掉内核注入的
#   "You are an AI agent powered by DeepSeek Harness."
# personaPrefix 做兜底（详细行为规范在插件的 systemPrompt.section 里），
# 防止插件未加载时露出 dsh 默认的编码 agent 人设。
- id: system-prompt
  config:
    includeHarnessIdentity: false
    personaPrefix: "你是「安全运维智能体」（soc-agent），部署在这台服务器上做故障诊断。先查证据再下结论；只诊断、只给方案，不执行修复命令。不知道日志在哪就用 ls_logs；不确定怎么查就 kb_lookup。"

# ── 沙箱锁死：只读 + 拒绝一切需审批操作 ──
# 不这么写，UI 里就能切「工作区读写 / 完全访问」，安全模型等于没有。
- id: sandbox-policy
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never

# 权限预设表只留 soc-readonly。workspace-write / danger-full-access
# **不写进来** —— UI 里就没有这两个选项可点。
- id: permission
  config:
    presets:
      soc-readonly:
        sandbox: read-only
        approval: never
        name: soc-readonly
        description: 只读；写操作与提权请求一律拒绝。本产品的唯一权限档。
    defaultPreset: soc-readonly'

  # dsh-tui profile 额外钉死 agent preset 与模式档位：
  # 不钉死的话，/preset 能切「梁神模式」，Shift+Tab 能在 default/plan/full 间循环。
  if [ "$PROFILE" = "dsh-tui" ]; then
    BLOCK="$BLOCK

# ── 钉死 agent preset 与模式（只留一个只读模式，Shift+Tab 无可切）──
- id: dsh-tui
  config:
    provider: deepseek-official
    fullscreen: true
    terminalImages: true
    effort: high
    preset: standard
    modes:
      - id: readonly
        plan: false
        sandbox: read-only
        approval: never"
  fi

  # 把注释行去掉后只剩 `[]`（或什么都没有）→ 整个文件重写，不能追加
  BODY="$(grep -v '^[[:space:]]*#' "$PATCH" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ -z "$BODY" ] || [ "$BODY" = "[]" ]; then
    {
      echo "# ${PROFILE} profile 补丁层（由 soc-agent/install.sh 写入）"
      echo "# 顶层必须是 YAML 数组；下列条目按 id 覆盖上面的 bundle 层。"
      echo
      printf '%s\n' "$BLOCK"
    } > "$PATCH"
    echo "已重写 ${PATCH}（原为空数组占位）"
  else
    {
      echo
      printf '%s\n' "$BLOCK"
    } >> "$PATCH"
    echo "已在 ${PATCH} 末尾追加挂载（原文件已有条目，保持不动）"
  fi
fi

# ── 3. 魔改 dsh-tui：封禁不该暴露的 UI 入口 ──
# 启动页的「会话与工作区 / 设置 / 有新版本」、底部参数行的 preset/permission、
# 以及联网查版本的 /update，都是 dsh-tui 硬编码的，插件层关不掉，只能改源码。
# 幂等：已打过补丁会自动跳过；回滚：tools/patch-dsh-tui.sh --revert
if [ -x "$HERE/tools/patch-dsh-tui.sh" ]; then
  echo ""
  echo "── 封禁 dsh-tui 多余入口 ──"
  sh "$HERE/tools/patch-dsh-tui.sh" || echo "警告：dsh-tui 补丁未完成（不影响插件功能）"
fi

echo ""
echo "装好了：$DEST"
echo "下一步："
echo "  1) 入库日志：node \"$DEST/bin/ingest.js\" <日志路径>"
if [ "$PROFILE" = "dsh-tui" ]; then
  echo "  2) 启动：soc           （先自检，通过才进界面）"
  echo "     或直接：\"$DEST/bin/soc\""
  echo "     建议加进 PATH：export PATH=\"$DEST/bin:\$PATH\""
  echo "  3) 直接说：「今天有什么异常」"
else
  echo "  2) 启动：dsh --profile $PROFILE \"今天有什么异常\""
fi
