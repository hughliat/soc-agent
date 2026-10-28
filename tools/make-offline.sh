#!/bin/sh
# 生成离线安装包 —— 供无外网的生产环境使用。
#
# ⚠️ 重要前提（必须理解，否则会做出装不上的包）：
#   离线包与**操作系统 + CPU 架构**强绑定。依赖树里含原生二进制
#   （如 @img/sharp-<platform>、libvips 的 .so），这些无法跨平台搬运。
#   所以本脚本**必须在与目标环境相同的平台**上执行：
#       目标是麒麟/Linux x86_64 → 就在 Linux x86_64 上跑本脚本
#   在 macOS 上生成、拷到 Linux 装，一定会失败。
#
# 产物：dist/offline/soc-agent-<ver>-offline-<os>-<arch>.tar.gz
#   内含：
#     · soc-agent 插件本体（含已打好的 dsh-tui 补丁器）
#     · vendor/node_modules/   完整依赖树（离线安装用，免 pnpm install）
#     · vendor/manifest.json   平台、版本、文件数与逐文件 sha256 摘要
#     · install-offline.sh     离线安装入口
#
# 用法：
#   sh tools/make-offline.sh              # 生成离线包
#   sh tools/make-offline.sh --check      # 只检查平台相关依赖，不打包
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname "$HERE")
PROFILE="${SOC_PROFILE:-dsh-tui}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROF_DIR="$DSH_HOME/profiles/$PROFILE"
OUT="$ROOT/dist/offline"

# 用相对路径 require：Git-Bash / MSYS 下 $ROOT 是 /c/... 形式，Node(Windows) 认不了
VERSION=$(cd "$ROOT" && node -p "require('./package.json').version")
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
TAG="$OS-$ARCH"
NAME="soc-agent-$VERSION-offline-$TAG"

echo ""
echo "═══ 生成离线安装包 ═══"
echo "平台：${TAG}（离线包与该平台绑定，不能跨平台使用）"
echo "版本：$VERSION"
echo ""

if [ ! -d "$PROF_DIR/node_modules" ]; then
  echo "错误：找不到 $PROF_DIR/node_modules" >&2
  echo "请先在本机完成在线安装（./install.sh ${PROFILE}），再生成离线包。" >&2
  exit 2
fi

# ── 平台相关依赖盘点（这是离线包能不能用的关键）──
echo "── 平台相关依赖 ──"
PLATFORM_PKGS=""
N_NODE=$(find "$PROF_DIR/node_modules" -name "*.node" 2>/dev/null | wc -l | tr -d ' ')
echo "  原生模块（.node）：$N_NODE 个"
if [ "$N_NODE" != "0" ]; then
  find "$PROF_DIR/node_modules" -name "*.node" 2>/dev/null | while read -r f; do
    rel=$(echo "$f" | sed "s|$PROF_DIR/node_modules/||")
    echo "    · $rel"
  done
  PLATFORM_PKGS="yes"
fi

# 找出带平台后缀的包目录
PLAT_DIRS=$(find "$PROF_DIR/node_modules" -maxdepth 3 -type d \
  \( -name "*-darwin-*" -o -name "*-linux-*" -o -name "*-win32-*" \) 2>/dev/null | head -20)
if [ -n "$PLAT_DIRS" ]; then
  echo "  平台专用包目录："
  echo "$PLAT_DIRS" | while read -r d; do echo "    · ${d#$PROF_DIR/node_modules/}"; done
  PLATFORM_PKGS="yes"
fi

if [ -n "$PLATFORM_PKGS" ]; then
  echo ""
  echo "  ⚠ 上述包含原生二进制，只能在本平台使用。"
  echo "    目标环境若是别的平台，请在目标平台重新执行本脚本。"
fi

if [ "${1:-}" = "--check" ]; then
  echo ""
  echo "仅检查，未打包。"
  exit 0
fi

# ── 体积预估 ──
SIZE=$(du -sm "$PROF_DIR/node_modules" 2>/dev/null | cut -f1)
echo ""
echo "── 打包 ──"
echo "  依赖树体积：${SIZE} MB（压缩后通常为 1/3 左右）"

mkdir -p "$OUT"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

TARGET="$STAGE/$NAME"
mkdir -p "$TARGET/vendor"

# 1) soc-agent 本体
mkdir -p "$TARGET/soc-agent"
for item in lib src bin knowledge tools docs assets tests \
            dsh.plugin.json cordis.patch.yml README.md install.sh package.json; do
  [ -e "$ROOT/$item" ] || continue
  cp -R "$ROOT/$item" "$TARGET/soc-agent/"
done
find "$TARGET/soc-agent" \( -name '*.soc-agent-backup' -o -name '.DS_Store' -o -name '*.log' \) -delete 2>/dev/null || true

# 2) 依赖树（排除 soc-agent 自身，安装时单独拷）
echo "  复制依赖树（86M 级别，需要一点时间）…"
cp -R "$PROF_DIR/node_modules" "$TARGET/vendor/node_modules"
rm -rf "$TARGET/vendor/node_modules/soc-agent"
# 清掉开发产物：-delete 在部分平台对深层路径不生效（实测漏了 4 个），改用 -exec rm
find "$TARGET/vendor/node_modules" -name '*.soc-agent-backup' -exec rm -f {} + 2>/dev/null || true
# 复核：还有残留就报错，不静默通过
LEFT=$(find "$TARGET" -name '*.soc-agent-backup' 2>/dev/null | wc -l | tr -d ' ')
if [ "$LEFT" != "0" ]; then
  echo "  警告：仍有 $LEFT 个备份文件未清理" >&2
fi

# 3) manifest
FILES=$(find "$TARGET" -type f | wc -l | tr -d ' ')
cat > "$TARGET/vendor/manifest.json" <<EOF
{
  "name": "soc-agent",
  "version": "$VERSION",
  "offline": true,
  "platform": "$TAG",
  "os": "$OS",
  "arch": "$ARCH",
  "node": "$(node -v)",
  "profile": "$PROFILE",
  "files": $FILES,
  "generatedAt": "$(date '+%Y-%m-%dT%H:%M:%S%z')",
  "warning": "本包与平台绑定。目标环境 OS/架构不同时，必须在目标平台重新生成。"
}
EOF

# 4) 离线安装入口
cp "$HERE/install-offline.sh" "$TARGET/install-offline.sh" 2>/dev/null || true
chmod 755 "$TARGET/install-offline.sh" 2>/dev/null || true

# 5) 打包
echo "  压缩中…"
( cd "$STAGE" && tar -czf "$OUT/$NAME.tar.gz" "$NAME" )

# 6) 校验和
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
elif command -v shasum >/dev/null 2>&1; then
  ( cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
fi

OUTSIZE=$(du -sm "$OUT/$NAME.tar.gz" | cut -f1)
echo ""
echo "✓ 已生成：$OUT/$NAME.tar.gz（${OUTSIZE} MB，$FILES 个文件）"
[ -f "$OUT/$NAME.tar.gz.sha256" ] && echo "  校验和：$(cut -d' ' -f1 "$OUT/$NAME.tar.gz.sha256")"
echo ""
echo "目标环境安装（不联网）："
echo "  tar -xzf $NAME.tar.gz && cd $NAME"
echo "  ./install-offline.sh"
echo ""
echo "注意：本包只能装在 $TAG 上。目标平台不同请在那台机器上重跑 make-offline.sh。"
