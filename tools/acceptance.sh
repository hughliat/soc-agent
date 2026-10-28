#!/bin/sh
# 发布前验收 —— 逐项核对「能不能在普通 Linux / 麒麟上装起来」。
#
# 为什么要有这个脚本：
#   口头说"检查过了"不可复算。发布前跑一遍，输出可归档，
#   换人复核时看到的是同一组结论。
#
# 用法：
#   sh tools/acceptance.sh              # 检查当前源码目录
#   sh tools/acceptance.sh <安装包>      # 额外检查安装包结构
#
# 退出码：0 全部通过 / 1 有阻断项
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PKG="${1:-}"
fatal=0
warn=0

ok()   { printf '  \033[32m[PASS]\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; fatal=$((fatal + 1)); }
note() { printf '  \033[33m[WARN]\033[0m %s\n' "$1"; warn=$((warn + 1)); }

echo ""
echo "═══ 发布前验收 · $(date '+%Y-%m-%d %H:%M:%S') ═══"
echo "源码：$ROOT"
echo ""

# ══════════ 1. 运行时依赖 ══════════
echo "── 1. 运行时依赖 ──"

if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -ge 18 ]; then
    ok "Node $(node -v)（要求 >= 18）"
  else
    bad "Node 版本过低：$(node -v)，要求 >= 18"
  fi
else
  bad "缺少 node（dsh 与全部工具都依赖它）"
fi

# python3 对本产品**不是必需**。安装链路一旦依赖它，麒麟最小化安装会直接装不上。
# --exclude 自身：否则检测命令会匹配到自己（自指误报）
# 只查 shell 脚本（.mjs/.js 里的注释提到 python3 不算调用）
PY_HITS=$(grep -rn "python3 " "$ROOT"/bin/*.sh "$ROOT"/tools/*.sh "$ROOT/install.sh" 2>/dev/null \
          | grep -v "acceptance.sh" | grep -v "不用 python3" \
          | grep -vE "^[^:]+:[0-9]+: *#" | wc -l | tr -d ' ')
if [ "$PY_HITS" = "0" ]; then
  ok "安装链路不依赖 python3"
else
  bad "安装链路仍有 $PY_HITS 处调用 python3（麒麟可能没有）"
fi

for cmd in tar gzip; do
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "基础命令可用：$cmd"
  else
    bad "缺少基础命令：$cmd"
  fi
done

# ══════════ 2. Shell 兼容性 ══════════
echo ""
echo "── 2. Shell 兼容性（麒麟的 /bin/sh 是 dash）──"

sh_bad=0
for f in $(find "$ROOT/bin" "$ROOT/tools" "$ROOT/install.sh" -name "*.sh" -o -name "install.sh" 2>/dev/null | sort -u); do
  if ! sh -n "$f" 2>/dev/null; then
    bad "语法错误（sh）：$(basename "$f")"
    sh_bad=1
  fi
done
[ "$sh_bad" = "0" ] && ok "全部 shell 脚本通过 dash 语法检查"

# bash 专有语法
BASHISM=$(grep -rnE '^\s*\[\[|^\s*local\s+-[aA]|\$\{[A-Za-z_]+\^|declare\s+-A' \
          "$ROOT/bin" "$ROOT/tools" "$ROOT/install.sh" 2>/dev/null | grep -v "space" | wc -l | tr -d ' ')
if [ "$BASHISM" = "0" ]; then
  ok "未使用 bash 专有语法"
else
  bad "发现 $BASHISM 处 bash 专有语法（dash 跑不了）"
fi

# sed -i 跨平台（BSD 需要 -i ''，GNU 需要 -i）
if grep -rqn --exclude=acceptance.sh "sed -i ''" "$ROOT/bin" "$ROOT/tools" 2>/dev/null; then
  bad "使用了 BSD 风格 sed -i ''，Linux 上会失败"
else
  ok "无 BSD 专属 sed -i 用法"
fi

# ══════════ 3. 命名与残留 ══════════
echo ""
echo "── 3. 命名与残留 ──"

DTOPS=$(grep -ric "dtops" "$ROOT/bin" "$ROOT/lib" "$ROOT/src" "$ROOT/docs" 2>/dev/null | grep -v ":0" | wc -l | tr -d ' ')
if [ "$DTOPS" = "0" ]; then
  ok "无旧项目名残留（dtops）"
else
  bad "仍有 dtops 残留，涉及 $DTOPS 个文件"
fi

# ══════════ 4. 权限 ══════════
echo ""
echo "── 4. 文件权限 ──"

for f in "$ROOT/install.sh" "$ROOT/bin/soc" "$ROOT/bin/argus" "$ROOT/bin/preflight.sh" \
         "$ROOT/bin/collect.sh" "$ROOT/bin/install-timer.sh" "$ROOT/tools/patch-dsh-tui.sh"; do
  if [ -f "$f" ]; then
    if [ -x "$f" ]; then
      ok "可执行：$(echo "$f" | sed "s|$ROOT/||")"
    else
      bad "缺执行位：$(echo "$f" | sed "s|$ROOT/||")（install 后 cron/systemd 调不了）"
    fi
  else
    bad "缺文件：$(echo "$f" | sed "s|$ROOT/||")"
  fi
done

# ══════════ 5. 单元测试 ══════════
echo ""
echo "── 5. 单元测试 ──"
if (cd "$ROOT" && node tests/run.js >/tmp/acc-test.log 2>&1); then
  summary=$(grep -oE '[0-9]+/[0-9]+ 通过' /tmp/acc-test.log | tail -1)
  ok "单测通过：${summary:-全部}"
else
  bad "单测失败，详见 /tmp/acc-test.log"
fi

# ══════════ 6. 安装包结构（可选） ══════════
if [ -n "$PKG" ] && [ -f "$PKG" ]; then
  echo ""
  echo "── 6. 安装包结构 ──"
  TMP=$(mktemp -d)
  if tar -tzf "$PKG" >/dev/null 2>&1; then
    ok "包可正常解压"
    tar -xzf "$PKG" -C "$TMP" 2>/dev/null
    TOP=$(ls "$TMP" | head -1)
    if [ -f "$TMP/$TOP/install.sh" ]; then ok "含 install.sh"; else bad "缺 install.sh"; fi
    for d in lib src bin knowledge tools docs; do
      if [ -d "$TMP/$TOP/$d" ]; then ok "含目录 $d/"; else bad "缺目录 $d/"; fi
    done
    if [ -x "$TMP/$TOP/bin/soc" ]; then ok "bin/soc 保留执行位"; else bad "bin/soc 丢执行位（解压后不可用）"; fi
    if find "$TMP/$TOP" -name "node_modules" -o -name "*.soc-agent-backup" | head -1 | grep -q .; then
      warn "包内混入了 node_modules 或备份文件"
    else
      ok "包内无 node_modules / 备份文件"
    fi
    if [ -f "$TMP/$TOP/package.json" ]; then
      v=$(node -p "require('$TMP/$TOP/package.json').version" 2>/dev/null || echo '?')
      ok "版本号：$v"
    fi
  else
    bad "包无法解压"
  fi
  rm -rf "$TMP"
fi


# ══════════ 7. 离线部署能力（生产内网必需）══════════
echo ""
echo "── 7. 离线部署能力 ──"
for f in tools/make-offline.sh tools/install-offline.sh; do
  if [ -x "$ROOT/$f" ]; then
    ok "存在且可执行：$f"
  else
    bad "缺失或不可执行：$f（内网环境无法安装）"
  fi
done
if [ -x "$ROOT/tools/make-offline.sh" ]; then
  if sh "$ROOT/tools/make-offline.sh" --check >/dev/null 2>&1; then
    ok "离线包生成脚本可运行"
  else
    bad "离线包生成脚本运行失败"
  fi
fi

# ══════════ 结论 ══════════
echo ""
echo "────────────────────────────────"
if [ "$fatal" -gt 0 ]; then
  printf '\033[31m✗ 验收未通过：%d 项阻断，%d 项警告\033[0m\n' "$fatal" "$warn"
  echo ""
  exit 1
fi
if [ "$warn" -gt 0 ]; then
  printf '\033[33m! 验收通过（%d 项警告）\033[0m\n' "$warn"
else
  printf '\033[32m✓ 验收全部通过，可用于生产部署\033[0m\n'
fi
echo ""
exit 0
