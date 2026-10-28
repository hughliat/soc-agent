#!/bin/sh
# 打安装包：解压后可直接 ./install.sh 安装。
#
# 产物：
#   dist/soc-agent-<version>.tar.gz        安装包（含全部运行文件）
#   dist/soc-agent-<version>.tar.gz.sha256 校验和
#   dist/部署说明.html                      部署说明（单文件，可离线看）
#
# 打包时排除：备份文件、node_modules、测试产物、点文件。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname "$HERE")
cd "$ROOT"

VERSION=$(node -p "require('./package.json').version")
NAME="soc-agent-$VERSION"
OUT="$ROOT/dist"

mkdir -p "$OUT"
rm -f "$OUT/$NAME.tar.gz" "$OUT/$NAME.tar.gz.sha256"

# 刷新文档里的版本号（文档版本必须与 package.json 同步）
# 部署说明与 README 都要刷版本号（两份都是对外文档）
for DOCFILE in "$ROOT/docs/07-部署说明.html" "$ROOT/README.html"; do
 [ -f "$DOCFILE" ] || continue
 node -e "
const fs=require('fs');
const v=require('$ROOT/package.json').version;
const f='$DOCFILE';
let s=fs.readFileSync(f,'utf8');
s=s.replace(/soc-agent-\d+\.\d+\.\d+/g,'soc-agent-'+v)
  .replace(/soc-agent v\d+\.\d+\.\d+/g,'soc-agent v'+v)
  .replace(/版本\s+\d+\.\d+\.\d+/g,'版本 '+v)
  .replace(/version \d+\.\d+\.\d+/g,'version '+v)
  .replace(/v\d+\.\d+\.\d+<\/strong>/g,'v'+v+'</strong>');
fs.writeFileSync(f,s);
"
done

if [ -f "$ROOT/docs/07-部署说明.html" ]; then
  node -e "
const fs=require('fs');
const v=require('$ROOT/package.json').version;
const f='$ROOT/docs/07-部署说明.html';
let s=fs.readFileSync(f,'utf8');
s=s.replace(/soc-agent-\\d+\\.\\d+\\.\\d+/g,'soc-agent-'+v)
  .replace(/soc-agent v\\d+\\.\\d+\\.\\d+/g,'soc-agent v'+v)
  .replace(/版本\\s+\\d+\\.\\d+\\.\\d+/g,'版本 '+v);
fs.writeFileSync(f,s);
"
fi

# 打包前先做文档自检：文档与代码漂移就不许出包（踩过三次）
if [ -f "$HERE/check-docs.mjs" ]; then
  if ! node "$HERE/check-docs.mjs" >/tmp/soc-docs.log 2>&1; then
    echo "✗ 文档与代码不一致，拒绝打包：" >&2
    tail -8 /tmp/soc-docs.log >&2
    exit 1
  fi
  echo "✓ 文档自检通过"
fi

echo "打包 $NAME …"

# 用 tar 打包（POSIX 标准，麒麟/Linux 一定有）。
# 不用 --transform（BSD tar 不支持），改为在临时目录建带版本号的副本再打包。
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME"
for item in lib src bin knowledge tools docs assets tests \
            dsh.plugin.json cordis.patch.yml README.md install.sh package.json; do
  [ -e "$ROOT/$item" ] || continue
  cp -R "$ROOT/$item" "$STAGE/$NAME/"
done
find "$STAGE/$NAME" \( -name '*.soc-agent-backup' -o -name '.DS_Store' -o -name '*.log' \) -delete 2>/dev/null || true
rm -rf "$STAGE/$NAME/node_modules" "$STAGE/$NAME/dist"
( cd "$STAGE" && tar -czf "$OUT/$NAME.tar.gz" "$NAME" )
echo "  已打包 $(find "$STAGE/$NAME" -type f | wc -l | tr -d ' ') 个文件"

# 校验和
if command -v shasum >/dev/null 2>&1; then
  (cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
else
  echo "警告：找不到 shasum/sha256sum，跳过校验和" >&2
fi

# 不往 dist/ 复制文档副本：
# 「部署说明.html」这个名字曾同时出现在 根 docs/、dist/、安装包内，
# 导致反复看错文件。现在只在安装包的 docs/ 里保留唯一一份。

SIZE=$(wc -c < "$OUT/$NAME.tar.gz" | tr -d ' ')
echo ""
echo "✓ $OUT/$NAME.tar.gz（$((SIZE / 1024)) KB）"
[ -f "$OUT/$NAME.tar.gz.sha256" ] && echo "✓ 校验和：$(cut -d' ' -f1 "$OUT/$NAME.tar.gz.sha256")"

echo ""
echo "安装步骤："
echo "  tar -xzf $NAME.tar.gz && cd $NAME"
echo "  ./install.sh dsh-tui"
echo ""
echo "装完用 \`soc\` 启动（先自检，通过才进界面）。"
