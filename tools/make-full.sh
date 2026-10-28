#!/bin/sh
# 打「真正能装起来」的一体化离线包 —— 把三层依赖全部打进去。
#
# 为什么需要这个：
#   dist/soc-agent-<ver>.tar.gz 只有 208 KB，那是**插件本体**，
#   不含 dsh 运行时（504 MB）和 dsh-tui 界面层（86 MB）。
#   拿 208 KB 的包到一个干净机器上，是装不起来的。
#   本脚本把三层打成一个约 200 MB 的包，目标机解压后 ./install-full.sh 即可。
#
# ⚠️ 平台绑定（这条最容易出错）：
#   包里含原生二进制（@img/sharp-<platform> 等），**只能在生成它的同一平台安装**。
#   要交付 Linux 服务器，就必须在一台 Linux 机器上跑本脚本。
#   在 macOS 上生成的包装不进 Linux —— 装的时候会被 install-full.sh 拒绝。
#
# 用法：
#   sh tools/make-full.sh            # 生成完整包
#   sh tools/make-full.sh --check    # 只盘点，不打包
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname "$HERE")
PROFILE="${SOC_PROFILE:-dsh-tui}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROF_DIR="$DSH_HOME/profiles/$PROFILE"
OUT="$ROOT/dist/full"

# 用相对路径 require：Git-Bash / MSYS 下 $ROOT 是 /c/... 形式，Node(Windows) 认不了
VERSION=$(cd "$ROOT" && node -p "require('./package.json').version")
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
TAG="$OS-$ARCH"
NAME="soc-agent-$VERSION-full-$TAG"

# dsh 全局包位置：**从 dsh 命令反推**，不要用 `npm root -g`。
# 踩过：机器上有多个 Node（如 nvm 的多版本），`npm` 和 `node` 可能来自不同版本，
# `npm root -g` 会指向另一个 Node 的目录，导致"找不到 dsh"。
resolve_dsh_global() {
  dsh_bin=$(command -v dsh 2>/dev/null || true)
  [ -z "$dsh_bin" ] && return 1
  # 跟随软链取真实路径
  real="$dsh_bin"
  if command -v readlink >/dev/null 2>&1; then
    r=$(readlink -f "$dsh_bin" 2>/dev/null || true)
    [ -n "$r" ] && real="$r"
  fi
  # real 形如 .../lib/node_modules/@deepseek-ai/dsh/lib/bin.js
  case "$real" in
    */@deepseek-ai/dsh/*)
      echo "${real%%/@deepseek-ai/dsh/*}/@deepseek-ai/dsh"
      return 0 ;;
  esac
  # 回退：node 所在目录的 lib/node_modules
  if command -v node >/dev/null 2>&1; then
    n=$(command -v node)
    cand="$(dirname "$(dirname "$n")")/lib/node_modules/@deepseek-ai/dsh"
    [ -d "$cand" ] && { echo "$cand"; return 0; }
  fi
  return 1
}

DSH_GLOBAL=$(resolve_dsh_global || echo "")
NPM_ROOT=$(dirname "$(dirname "$DSH_GLOBAL")" 2>/dev/null || echo "")

echo ""
echo "═══ 打一体化离线包 ═══"
echo "平台：${TAG}（本包只能装在 ${TAG} 上）"
echo "版本：${VERSION}"
echo ""

# ── 盘点三层 ──
echo "── 依赖盘点 ──"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：需要 node 才能打包。" >&2
  exit 2
fi
ok_node="Node $(node -v)"
echo "  ✓ ${ok_node}"

if [ -d "$DSH_GLOBAL" ]; then
  sz=$(du -sm "$DSH_GLOBAL" 2>/dev/null | cut -f1)
  echo "  ✓ dsh 全局包：${DSH_GLOBAL}（${sz} MB）"
  HAVE_DSH=1
else
  echo "  ✗ 找不到 dsh 全局包：${DSH_GLOBAL}" >&2
  echo "    先执行：npm i -g @deepseek-ai/dsh" >&2
  HAVE_DSH=0
fi

if [ -d "$PROF_DIR/node_modules" ]; then
  sz=$(du -sm "$PROF_DIR/node_modules" 2>/dev/null | cut -f1)
  echo "  ✓ dsh-tui 依赖树：${sz} MB"
  HAVE_TUI=1
else
  echo "  ✗ 找不到 $PROF_DIR/node_modules" >&2
  echo "    先执行一次 dsh --profile ${PROFILE} 让它自举并装好界面层" >&2
  HAVE_TUI=0
fi

sz=$(du -sm "$ROOT" 2>/dev/null | cut -f1)
echo "  ✓ soc-agent 本体：${sz} MB（含源码与文档）"

# 平台相关二进制提示
N_NODE=$(find "$PROF_DIR/node_modules" "$DSH_GLOBAL" -name "*.node" 2>/dev/null | wc -l | tr -d ' ')
echo "  · 原生模块：${N_NODE} 个（因此本包与 ${TAG} 绑定）"

if [ "${1:-}" = "--check" ]; then
  echo ""
  echo "仅盘点，未打包。"
  exit 0
fi

if [ "$HAVE_DSH" = "0" ] || [ "$HAVE_TUI" = "0" ]; then
  echo "" >&2
  echo "缺少必需依赖，无法打出可安装的包。" >&2
  exit 2
fi

# ── 组装 ──
mkdir -p "$OUT"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
TARGET="$STAGE/$NAME"
mkdir -p "$TARGET/vendor"

echo ""
echo "── 组装（约 600 MB，需要几分钟）──"

# 1) soc-agent 本体
echo "  [1/4] soc-agent 本体…"
mkdir -p "$TARGET/soc-agent"
for item in lib src bin knowledge tools docs assets tests \
            dsh.plugin.json cordis.patch.yml README.md README.html install.sh package.json; do
  [ -e "$ROOT/$item" ] || continue
  cp -R "$ROOT/$item" "$TARGET/soc-agent/"
done
find "$TARGET/soc-agent" \( -name '*.soc-agent-backup' -o -name '.DS_Store' -o -name '*.log' \) -delete 2>/dev/null || true

# 2) dsh 全局包
echo "  [2/4] dsh 运行时（504 MB 级）…"
mkdir -p "$TARGET/vendor/npm-global/@deepseek-ai"
cp -R "$DSH_GLOBAL" "$TARGET/vendor/npm-global/@deepseek-ai/dsh"

# 3) dsh-tui 依赖树（排除 soc-agent 自身，安装时单独拷）
echo "  [3/4] dsh-tui 依赖树（86 MB 级）…"
cp -R "$PROF_DIR/node_modules" "$TARGET/vendor/node_modules"
rm -rf "$TARGET/vendor/node_modules/soc-agent"
find "$TARGET/vendor/node_modules" -name '*.soc-agent-backup' -exec rm -f {} + 2>/dev/null || true

# 4) 安装脚本 + manifest
echo "  [4/4] 安装入口…"
cp "$HERE/install-full.sh" "$TARGET/install-full.sh" 2>/dev/null || true
chmod 755 "$TARGET/install-full.sh" 2>/dev/null || true

FILES=$(find "$TARGET" -type f 2>/dev/null | wc -l | tr -d ' ')
cat > "$TARGET/vendor/manifest.json" <<EOF
{
  "name": "soc-agent",
  "version": "${VERSION}",
  "bundle": "full",
  "platform": "${TAG}",
  "os": "${OS}",
  "arch": "${ARCH}",
  "node": "$(node -v)",
  "profile": "${PROFILE}",
  "files": ${FILES},
  "layers": {
    "soc-agent": "插件本体（208 KB 级）",
    "dsh": "运行时全局包（504 MB 级）",
    "dsh-tui": "界面层依赖树（86 MB 级）"
  },
  "generatedAt": "$(date '+%Y-%m-%dT%H:%M:%S%z')",
  "warning": "含原生二进制，只能安装在 ${TAG} 上。跨平台必须重新生成。"
}
EOF

# 清理开发产物（复核，不静默放过）
LEFT=$(find "$TARGET" -name '*.soc-agent-backup' 2>/dev/null | wc -l | tr -d ' ')
[ "$LEFT" != "0" ] && echo "  警告：仍有 $LEFT 个备份文件" >&2

echo "  压缩中（这一步最慢）…"
( cd "$STAGE" && tar -czf "$OUT/$NAME.tar.gz" "$NAME" )

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
elif command -v shasum >/dev/null 2>&1; then
  ( cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
fi

OUTSIZE=$(du -sm "$OUT/$NAME.tar.gz" | cut -f1)
echo ""
echo "✓ 已生成：$OUT/$NAME.tar.gz（${OUTSIZE} MB，${FILES} 个文件）"
[ -f "$OUT/$NAME.tar.gz.sha256" ] && echo "  校验和：$(cut -d' ' -f1 "$OUT/$NAME.tar.gz.sha256")"
echo ""
echo "目标机安装（不需要外网、不需要预装 dsh）："
echo "  tar -xzf $NAME.tar.gz && cd $NAME"
echo "  ./install-full.sh"
echo ""
echo "⚠ 本包只能装在 ${TAG} 上。交付 Linux 请在 Linux 机器上重跑本脚本。"
