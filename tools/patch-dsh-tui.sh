#!/bin/sh
# 魔改 dsh-tui：封禁 soc-agent 不该暴露的 UI 入口。
#
# 为什么改上游源码：启动页入口、命令表、更新检查都是 dsh-tui 里硬编码的
# 纯函数返回值，没有配置开关，插件层关不掉。
#
# 本脚本只做编排，真正的替换逻辑在 tools/patcher.mjs（Node 实现）。
# **不用 python3** —— 生产环境是麒麟/最小化 Linux，python3 不保证存在，
# 而 dsh 自身依赖 Node，Node 一定在。这是"零第三方依赖"承诺的一部分。
#
# 用法：
#   sh patch-dsh-tui.sh            打补丁（幂等 + 增量）
#   sh patch-dsh-tui.sh --revert   从备份回滚
#   sh patch-dsh-tui.sh --check    只检查补丁完整性，不改动
#
# 幂等说明：重复执行不会重复插入；已打过时会逐项检查缺漏并补齐。
#（"已打过就跳过"会导致后来新增的替换项永远不生效——踩过这个坑）
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MARK_PREFIX='SOC_AGENT_PATCH'
PATCHER="$HERE/patcher.mjs"

# ── 依赖检查（缺 node 直接失败，不静默降级）──
if ! command -v node >/dev/null 2>&1; then
  echo "错误：找不到 node。本补丁需要 Node.js（dsh 本身也依赖它）。" >&2
  exit 2
fi
if [ ! -f "$PATCHER" ]; then
  echo "错误：找不到 $PATCHER" >&2
  exit 2
fi

# dsh 加载的是 profile 里的那份 dsh-tui，不是全局 nvm 那份。
# 两处都可能存在，全部打一遍。
discover_tui_dirs() {
  if [ -n "${DSH_TUI_DIR:-}" ]; then
    echo "$DSH_TUI_DIR"
    return
  fi
  for d in "$HOME"/.dsh/profiles/*/node_modules/@deepseek-harness-tui/dsh-tui \
           "$HOME"/.nvm/versions/node/*/lib/node_modules/@deepseek-harness-tui/dsh-tui \
           /usr/local/lib/node_modules/@deepseek-harness-tui/dsh-tui \
           /usr/lib/node_modules/@deepseek-harness-tui/dsh-tui; do
    [ -d "$d/lib/types" ] && echo "$d"
  done
  # set -e 下，函数最后一行为假会让整个赋值失败并静默退出（踩过）
  return 0
}

TUI_DIRS=$(discover_tui_dirs)
if [ -z "$TUI_DIRS" ]; then
  echo "找不到任何 dsh-tui 安装。用 DSH_TUI_DIR 指定实际路径。" >&2
  exit 2
fi

backup_once() {
  f="$1"
  if [ ! -f "$f.soc-agent-backup" ]; then
    cp "$f" "$f.soc-agent-backup"
    echo "  备份 → $(basename "$f").soc-agent-backup"
  fi
}

# ── 回滚 ──
if [ "${1:-}" = "--revert" ]; then
  n=0
  for d in $TUI_DIRS; do
    for f in "$d/lib/types/components/launchpadActions.js" \
             "$d/lib/types/screens/Launchpad.js" \
             "$d/lib/types/components/LogoV2.js" \
             "$d/lib/types/components/Whale.js" \
             "$d/lib/types/commands.js" \
             "$d/lib/types/i18n.js" \
             "$d/lib/types/update.js"; do
      if [ -f "$f.soc-agent-backup" ]; then
        cp "$f.soc-agent-backup" "$f"
        echo "已恢复 $f"
        n=$((n + 1))
      fi
    done
  done
  echo "回滚完成（$n 个文件）"
  exit 0
fi

# ── 只检查 ──
if [ "${1:-}" = "--check" ]; then
  bad=0
  check_one() {
    label="$1"; file="$2"; mark="$3"
    if [ -f "$file" ] && grep -q "$mark" "$file" 2>/dev/null; then
      echo "  ✓ $label"
    else
      echo "  ✗ $label（缺 $mark）"
      bad=1
    fi
  }
  for d in $TUI_DIRS; do
    echo "检查：$d"
    check_one "启动页入口" "$d/lib/types/components/launchpadActions.js" "$MARK_PREFIX:launchpad"
    check_one "参数行"     "$d/lib/types/screens/Launchpad.js"           "$MARK_PREFIX:params"
    check_one "命令白名单" "$d/lib/types/commands.js"                    "$MARK_PREFIX:commands"
    check_one "更新检查"   "$d/lib/types/update.js"                       "$MARK_PREFIX:update"
    check_one "界面文案"   "$d/lib/types/i18n.js"                         "$MARK_PREFIX:i18n"
    check_one "侧栏标识"   "$d/lib/types/components/Whale.js"             "$MARK_PREFIX:logo"
    check_one "启动页标识" "$d/lib/types/screens/Launchpad.js"           "$MARK_PREFIX:logo2"
    check_one "组件标识"   "$d/lib/types/components/LogoV2.js"            "$MARK_PREFIX:logo3"
  done
  if [ "$bad" = "0" ]; then echo "全部就位"; else echo "存在缺失，执行：sh $0"; fi
  exit "$bad"
fi

# ── 打补丁 ──
for TUI_DIR in $TUI_DIRS; do
  echo "══════ 补丁目标：$TUI_DIR"

  L="$TUI_DIR/lib/types/components/launchpadActions.js"
  P="$TUI_DIR/lib/types/screens/Launchpad.js"
  U="$TUI_DIR/lib/types/update.js"
  C="$TUI_DIR/lib/types/commands.js"
  I="$TUI_DIR/lib/types/i18n.js"
  W="$TUI_DIR/lib/types/components/Whale.js"
  V="$TUI_DIR/lib/types/components/LogoV2.js"

  missing=0
  for f in "$L" "$P" "$U" "$C" "$I" "$W" "$V"; do
    if [ ! -f "$f" ]; then
      echo "  缺少文件：$f，跳过本副本" >&2
      missing=1
      break
    fi
  done
  [ "$missing" = "1" ] && continue

  for f in "$L" "$P" "$U" "$C" "$I" "$W" "$V"; do backup_once "$f"; done

  node "$PATCHER" launchpad "$L" || { echo "  ✗ 启动页补丁失败" >&2; exit 1; }
  node "$PATCHER" params    "$P" || { echo "  ✗ 参数行补丁失败" >&2; exit 1; }
  node "$PATCHER" commands  "$C" || { echo "  ✗ 命令白名单补丁失败" >&2; exit 1; }
  node "$PATCHER" update    "$U" || { echo "  ✗ 更新检查补丁失败" >&2; exit 1; }
  node "$PATCHER" i18n      "$I" || { echo "  ✗ 文案补丁失败" >&2; exit 1; }
  node "$PATCHER" logo      "$W" || { echo "  ✗ 侧栏标识补丁失败" >&2; exit 1; }
  node "$PATCHER" logo2     "$P" || { echo "  ✗ 启动页标识补丁失败" >&2; exit 1; }
  node "$PATCHER" logo3     "$V" || { echo "  ✗ 组件标识补丁失败" >&2; exit 1; }

  # ── 语法校验：错一个就回滚该文件，绝不留半成品 ──
  echo ""
  fail=0
  for f in "$L" "$P" "$U" "$C" "$I" "$W" "$V"; do
    if node --check "$f" >/tmp/soc-nodecheck.err 2>&1; then
      echo "  ✓ 语法 OK：$(basename "$f")"
    else
      echo "  ✗ 语法错误：$f" >&2
      head -4 /tmp/soc-nodecheck.err >&2
      if [ -f "$f.soc-agent-backup" ]; then
        cp "$f.soc-agent-backup" "$f"
        echo "    已回滚该文件" >&2
      fi
      fail=1
    fi
  done
  if [ "$fail" -ne 0 ]; then
    echo "补丁失败，已回滚出错文件。请把上面的错误反馈。" >&2
    exit 1
  fi
  echo ""
done

echo "补丁完成。"
echo "  检查完整性：sh $0 --check"
echo "  回滚：      sh $0 --revert"
echo "  注意：dsh-tui 升级后补丁会丢失，用 sh tools/upgrade.sh 或重跑本脚本。"
