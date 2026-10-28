#!/bin/sh
# 一体化离线安装 —— 不需要外网、不需要预装 dsh。
#
# 装的四层（顺序不可颠倒）：
#   1. 检查 Node（本包不含，需目标机已有 ≥ 18）
#   2. dsh 运行时      → 拷到 npm 全局 root
#   3. dsh-tui 依赖树  → 拷到 profile 的 node_modules
#   4. soc-agent 插件  → 拷入并打界面封禁补丁
#
# 前置只有一条：目标机已装 Node ≥ 18。其余全部随包。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROFILE="${1:-${SOC_PROFILE:-dsh-tui}}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROF_DIR="$DSH_HOME/profiles/$PROFILE"
MANIFEST="$HERE/vendor/manifest.json"

echo ""
echo "═══ 一体化离线安装 ═══"
echo "profile：${PROF_DIR}"
echo ""

# ── 1. Node ──
if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'MSG'
错误：找不到 node。

  本离线包不含 Node 运行时（跨平台无法通用），需要目标机预先安装 Node.js ≥ 18。

  麒麟/内网环境建议用官方二进制包，不要用系统源（版本常低于 18）：
    curl -O https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz
    tar -xJf node-v20.18.0-linux-x64.tar.xz -C /opt
    export PATH="/opt/node-v20.18.0-linux-x64/bin:$PATH"

  验证：node -v
MSG
  exit 2
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误：Node 版本过低（$(node -v)），需要 ≥ 18。" >&2
  exit 2
fi
echo "✓ Node $(node -v)"

# ── 2. 平台校验（跨平台装必然失败，提前拦）──
if [ -f "$MANIFEST" ]; then
  PKG_PLATFORM=$(node -p "require('$MANIFEST').platform" 2>/dev/null || echo '?')
  NOW_PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
  if [ "$PKG_PLATFORM" != "$NOW_PLATFORM" ]; then
    cat >&2 <<MSG

错误：平台不匹配，无法安装。

  离线包：${PKG_PLATFORM}
  本机：  ${NOW_PLATFORM}

  本包含平台专属二进制（sharp/libvips 等），跨平台装不上。
  请在 ${NOW_PLATFORM} 上重新执行 tools/make-full.sh 生成对应的包。

MSG
    exit 2
  fi
  echo "✓ 平台匹配：${PKG_PLATFORM}"
  echo "✓ 包版本：$(node -p "require('$MANIFEST').version")"
fi

# ── 3. 装 dsh 运行时 ──
echo ""
echo "── [1/4] dsh 运行时 ──"
# 全局包位置：从 node 命令反推（多版本 Node 环境下 npm root -g 可能指向别处）
NPM_ROOT="$(dirname "$(dirname "$(command -v node)")")/lib/node_modules"
if [ ! -d "$NPM_ROOT" ]; then
  # 回退尝试
  NPM_ROOT=$(npm root -g 2>/dev/null || echo "")
fi
if [ -z "$NPM_ROOT" ] || [ ! -d "$NPM_ROOT" ]; then
  echo "错误：定位不到 npm 全局 node_modules（试过 node 路径反推与 npm root -g）。" >&2
  exit 2
fi
if [ -d "$HERE/vendor/npm-global/@deepseek-ai/dsh" ]; then
  if [ -d "$NPM_ROOT/@deepseek-ai/dsh" ]; then
    BAK="$NPM_ROOT/@deepseek-ai/dsh.bak.$(date +%Y%m%d%H%M%S)"
    mv "$NPM_ROOT/@deepseek-ai/dsh" "$BAK"
    echo "  已有 dsh，备份到：$BAK"
  fi
  mkdir -p "$NPM_ROOT/@deepseek-ai"
  cp -R "$HERE/vendor/npm-global/@deepseek-ai/dsh" "$NPM_ROOT/@deepseek-ai/dsh"
  chmod 755 "$NPM_ROOT/@deepseek-ai/dsh/bin/"* 2>/dev/null || true
  echo "  ✓ dsh 已装到 $NPM_ROOT/@deepseek-ai/dsh"
else
  echo "错误：包内缺 vendor/npm-global/@deepseek-ai/dsh" >&2
  exit 2
fi

# dsh 命令入口：npm 全局 bin 通常已软链，没有就补一个
if ! command -v dsh >/dev/null 2>&1; then
  BINDIR=$(npm bin -g 2>/dev/null || echo "$NPM_ROOT/../../bin")
  if [ -f "$NPM_ROOT/@deepseek-ai/dsh/lib/bin.js" ]; then
    mkdir -p "$BINDIR" 2>/dev/null || true
    ln -sf "$NPM_ROOT/@deepseek-ai/dsh/lib/bin.js" "$BINDIR/dsh" 2>/dev/null || true
    chmod +x "$NPM_ROOT/@deepseek-ai/dsh/lib/bin.js" 2>/dev/null || true
  fi
fi
if command -v dsh >/dev/null 2>&1; then
  echo "  ✓ dsh 命令可用：$(command -v dsh)"
else
  echo "  ! dsh 命令未进 PATH，请手工加：export PATH=\"$NPM_ROOT/../../bin:\$PATH\"" >&2
fi

# ── 4. 装 dsh-tui 依赖树 ──
echo ""
echo "── [2/4] dsh-tui 依赖树 ──"
mkdir -p "$PROF_DIR"
if [ -d "$PROF_DIR/node_modules" ]; then
  BAK="$PROF_DIR/node_modules.bak.$(date +%Y%m%d%H%M%S)"
  mv "$PROF_DIR/node_modules" "$BAK"
  echo "  已有 node_modules，备份到：$BAK"
fi
cp -R "$HERE/vendor/node_modules" "$PROF_DIR/node_modules"
echo "  ✓ 依赖树已就位（跳过包管理器，不联网）"

# ── 5. 装 soc-agent ──
echo ""
echo "── [3/4] soc-agent 插件 ──"
if [ ! -d "$HERE/soc-agent" ]; then
  echo "错误：包内缺 soc-agent 目录。" >&2
  exit 2
fi
rm -rf "$PROF_DIR/node_modules/soc-agent"
cp -R "$HERE/soc-agent" "$PROF_DIR/node_modules/soc-agent"
chmod 755 "$PROF_DIR/node_modules/soc-agent/bin/"*.sh \
          "$PROF_DIR/node_modules/soc-agent/install.sh" 2>/dev/null || true
echo "  ✓ 已装到 $PROF_DIR/node_modules/soc-agent"

# ── 6. 挂载 + 打补丁 ──
echo ""
echo "── [4/4] 挂载与界面封禁 ──"
if [ -x "$PROF_DIR/node_modules/soc-agent/install.sh" ]; then
  sh "$PROF_DIR/node_modules/soc-agent/install.sh" "$PROFILE" || {
    echo "  警告：挂载脚本返回非零，请检查 $PROF_DIR/cordis.patch.yml" >&2
  }
fi

if [ -f "$PROF_DIR/node_modules/soc-agent/tools/patch-dsh-tui.sh" ]; then
  sh "$PROF_DIR/node_modules/soc-agent/tools/patch-dsh-tui.sh" || {
    echo "  警告：界面补丁未完成。" >&2
  }
fi

# ── 7. 自检 ──
echo ""
echo "── 安装后自检 ──"
if [ -x "$PROF_DIR/node_modules/soc-agent/bin/preflight.sh" ]; then
  sh "$PROF_DIR/node_modules/soc-agent/bin/preflight.sh" || true
fi

cat <<MSG

═══ 安装完成 ═══

启动：
  $PROF_DIR/node_modules/soc-agent/bin/soc

建议加进 PATH：
  export PATH="$PROF_DIR/node_modules/soc-agent/bin:\$PATH"
  soc

还没配的（按需）：
  · 模型端点：SOC_LLM_BASE_URL / SOC_LLM_API_KEY
  · 邮件外发：SOC_SMTP_* / SOC_MAIL_ALLOWLIST
  · 定时巡检：sh bin/install-timer.sh

MSG
