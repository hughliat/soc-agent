#!/bin/sh
# 离线安装 —— 不联网、不依赖 pnpm/npm registry。
#
# 与在线安装的区别：
#   在线：dsh plugin add 从 registry 拉依赖（需要外网/内网源）
#   离线：直接把随包的 vendor/node_modules 铺到 profile 目录，跳过包管理器
#
# 前置条件（脚本会检查）：
#   1. 本机已装 node（≥18）与 dsh CLI
#   2. 离线包平台与目标机一致（OS + 架构）
#
# 用法：
#   ./install-offline.sh              # 装到默认 profile dsh-tui
#   ./install-offline.sh <profile>    # 装到指定 profile
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROFILE="${1:-${SOC_PROFILE:-dsh-tui}}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROF_DIR="$DSH_HOME/profiles/$PROFILE"
MANIFEST="$HERE/vendor/manifest.json"

echo ""
echo "═══ 离线安装 ═══"
echo "profile：$PROF_DIR"
echo ""

# ── 1. 前置检查 ──
if ! command -v node >/dev/null 2>&1; then
  echo "错误：找不到 node。请先安装 Node.js ≥ 18。" >&2
  exit 2
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误：Node 版本过低（$(node -v)），需要 ≥ 18。" >&2
  exit 2
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo "错误：找不到 dsh CLI。离线包只含插件依赖，dsh 本体需预先安装。" >&2
  echo "  在有网环境执行：npm i -g @deepseek-ai/dsh" >&2
  echo "  再把全局包整个拷过来（见部署说明「离线部署」一节）。" >&2
  exit 2
fi

if [ ! -d "$HERE/vendor/node_modules" ]; then
  echo "错误：离线包不完整，缺 vendor/node_modules。" >&2
  exit 2
fi

# ── 2. 平台校验（跨平台装必然失败，提前拦住）──
if [ -f "$MANIFEST" ]; then
  PKG_PLATFORM=$(node -p "require('$MANIFEST').platform" 2>/dev/null || echo '?')
  NOW_PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
  if [ "$PKG_PLATFORM" != "$NOW_PLATFORM" ]; then
    echo "" >&2
    echo "错误：平台不匹配。" >&2
    echo "  离线包：$PKG_PLATFORM" >&2
    echo "  本机：  $NOW_PLATFORM" >&2
    echo "" >&2
    echo "离线包含平台专属二进制，不能跨平台使用。" >&2
    echo "请在 $NOW_PLATFORM 上重新执行 tools/make-offline.sh 生成对应的包。" >&2
    exit 2
  fi
  echo "✓ 平台匹配：$PKG_PLATFORM"
  echo "✓ 包版本：$(node -p "require('$MANIFEST').version")（生成于 $(node -p "require('$MANIFEST').generatedAt")）"
fi

# ── 3. 铺依赖树 ──
echo ""
echo "── 安装依赖树 ──"
mkdir -p "$PROF_DIR"
if [ -d "$PROF_DIR/node_modules" ]; then
  BAK="$PROF_DIR/node_modules.bak.$(date +%Y%m%d%H%M%S)"
  echo "  已存在 node_modules，备份到：$BAK"
  mv "$PROF_DIR/node_modules" "$BAK"
fi
cp -R "$HERE/vendor/node_modules" "$PROF_DIR/node_modules"
echo "  ✓ 依赖树已就位（跳过 pnpm / npm registry）"

# ── 4. 安装插件本体 ──
echo ""
echo "── 安装插件 ──"
if [ -d "$HERE/soc-agent" ]; then
  rm -rf "$PROF_DIR/node_modules/soc-agent"
  cp -R "$HERE/soc-agent" "$PROF_DIR/node_modules/soc-agent"
  echo "  ✓ 插件已拷入 $PROF_DIR/node_modules/soc-agent"
else
  echo "错误：离线包缺 soc-agent 目录。" >&2
  exit 2
fi

# ── 5. 挂载到 profile 并锁死权限 ──
echo ""
echo "── 挂载与安全配置 ──"
if [ -x "$PROF_DIR/node_modules/soc-agent/install.sh" ]; then
  # 复用在线安装脚本的挂载逻辑（它会幂等补齐权限锁死）
  sh "$PROF_DIR/node_modules/soc-agent/install.sh" "$PROFILE" || {
    echo "警告：挂载脚本返回非零，请手工检查 $PROF_DIR/cordis.patch.yml" >&2
  }
else
  echo "警告：找不到 install.sh，需手工把插件挂到 cordis.patch.yml" >&2
fi

# ── 6. 重打界面封禁补丁 ──
echo ""
echo "── 界面封禁补丁 ──"
if [ -f "$PROF_DIR/node_modules/soc-agent/tools/patch-dsh-tui.sh" ]; then
  sh "$PROF_DIR/node_modules/soc-agent/tools/patch-dsh-tui.sh" || {
    echo "警告：补丁未完成，界面入口可能未封禁。" >&2
  }
fi

# ── 7. 自检 ──
echo ""
echo "── 启动自检 ──"
if [ -x "$PROF_DIR/node_modules/soc-agent/bin/preflight.sh" ]; then
  sh "$PROF_DIR/node_modules/soc-agent/bin/preflight.sh" || true
fi

echo ""
echo "安装完成。"
echo "  启动：$PROF_DIR/node_modules/soc-agent/bin/soc"
echo "  或加进 PATH：export PATH=\"$PROF_DIR/node_modules/soc-agent/bin:\$PATH\" && soc"
echo ""
echo "提醒：离线包不含 dsh 本体。目标机若无 dsh，需从同平台机器拷全局包："
echo "  源机：tar -czf dsh-global.tgz -C \$(npm root -g) @deepseek-ai"
echo "  目标：tar -xzf dsh-global.tgz -C \$(npm root -g)"
echo ""
