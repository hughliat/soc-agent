#!/bin/sh
# 升级 dsh-tui 并自动重打全部补丁。
#
# 为什么需要这个脚本：
#   soc-agent 对 dsh-tui 做了源码级封禁（tools/patch-dsh-tui.sh 改 5 个文件）。
#   dsh-tui 一升级，node_modules 被整个替换，补丁全丢 —— 表现为：
#     启动页又出现「会话与工作区 / 设置 / 有新版本」
#     命令面板又变回 63 个
#   手工记得重跑补丁是不可靠的，所以做成一条命令。
#
# 用法：
#   sh tools/upgrade.sh                 # 升级到 latest 并重打补丁
#   sh tools/upgrade.sh 0.14.0          # 升级到指定版本
#   sh tools/upgrade.sh --check         # 只看当前版本，不动手
#
# 安全设计：
#   1. 升级前备份整个 profile 的 package.json + pnpm-lock.yaml
#   2. 升级后**必须**重打补丁，否则拒绝报告成功
#   3. 补丁后跑单测 + dump-config 验证，任一失败即告警
#   4. 不自动升级：本产品锁版本，升级是变更动作，由人发起
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname "$HERE")
PROFILE="${SOC_PROFILE:-dsh-tui}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
TUI_DIR="$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-harness-tui/dsh-tui"

cur_version() {
  if [ -f "$TUI_DIR/package.json" ]; then
    node -p "require('$TUI_DIR/package.json').version" 2>/dev/null || echo '?'
  else
    echo '未安装'
  fi
}

echo "dsh-tui 当前版本：$(cur_version)"
echo "profile：$DSH_HOME/profiles/$PROFILE"
echo ""

if [ "${1:-}" = "--check" ]; then
  echo "只检查，不做改动。要升级：sh tools/upgrade.sh [版本]"
  exit 0
fi

if [ ! -d "$DSH_HOME/profiles/$PROFILE" ]; then
  echo "找不到 profile：$DSH_HOME/profiles/$PROFILE" >&2
  exit 2
fi

TARGET="${1:-latest}"

# ── 1. 备份 ──
STAMP=$(date +%Y%m%d-%H%M%S)
BK="$DSH_HOME/.backup-upgrade-$STAMP"
mkdir -p "$BK"
for f in package.json pnpm-lock.yaml; do
  [ -f "$DSH_HOME/profiles/$PROFILE/$f" ] && cp "$DSH_HOME/profiles/$PROFILE/$f" "$BK/$f"
done
echo "已备份到：$BK"
echo ""

# ── 2. 升级 ──
echo "升级到 @deepseek-harness-tui/dsh-tui@$TARGET …"
if ! dsh plugin --profile "$PROFILE" add "@deepseek-harness-tui/dsh-tui@$TARGET"; then
  echo "升级失败。profile 未改动（或已停在失败态），可从备份恢复：" >&2
  echo "  cp $BK/package.json $BK/pnpm-lock.yaml $DSH_HOME/profiles/$PROFILE/" >&2
  exit 1
fi
echo "升级完成，新版本：$(cur_version)"
echo ""

# ── 3. 重打补丁（必须）──
echo "重打封禁补丁 …"
if ! sh "$HERE/patch-dsh-tui.sh"; then
  echo "" >&2
  echo "✗ 补丁失败 —— **当前处于未封禁状态，不要直接用**。" >&2
  echo "  排查后重跑：sh tools/patch-dsh-tui.sh" >&2
  echo "  或回滚：cp $BK/package.json $BK/pnpm-lock.yaml $DSH_HOME/profiles/$PROFILE/ && 重跑 install.sh" >&2
  exit 1
fi
echo ""

# ── 4. 验证 ──
echo "验证 …"
fail=0

# 4a. 命令白名单是否仍是 6 个
n=$(cd "$TUI_DIR" && node --input-type=module -e "
const m = await import('./lib/types/commands.js');
process.stdout.write(String(m.LOCAL_COMMANDS.length));
" 2>/dev/null || echo 'err')
if [ "$n" = "8" ]; then
  echo "  ✓ 命令白名单：8 个（help/exit/quit/q/model/status/lang/theme）"
else
  echo "  ✗ 命令白名单异常（期望 8，实际 $n）—— help 可能被误删或补丁未生效" >&2
  fail=1
fi

# 4b. 更新检查是否已禁用
if grep -q 'SOC_AGENT_PATCH:update' "$TUI_DIR/lib/types/update.js" 2>/dev/null; then
  echo "  ✓ 更新检查：已禁用联网"
else
  echo "  ✗ 更新检查补丁缺失" >&2
  fail=1
fi

# 4c. 启动页入口是否已摘
if grep -q 'SOC_AGENT_PATCH:launchpad' "$TUI_DIR/lib/types/components/launchpadActions.js" 2>/dev/null; then
  echo "  ✓ 启动页入口：已摘"
else
  echo "  ✗ 启动页补丁缺失" >&2
  fail=1
fi

# 4d. 插件单测
if [ -f "$ROOT/tests/run.js" ]; then
  if (cd "$ROOT" && node tests/run.js >/dev/null 2>&1); then
    echo "  ✓ 插件单测：通过"
  else
    echo "  ✗ 插件单测失败（跑 node tests/run.js 看详情）" >&2
    fail=1
  fi
fi

echo ""
if [ "$fail" -ne 0 ]; then
  echo "✗ 升级后验证未全部通过，请勿直接交付。" >&2
  exit 1
fi
echo "✓ 升级完成且封禁完好。备份留在：$BK"
echo "  建议：启动 dst 目视确认启动页只剩模型与思考深度两段。"
