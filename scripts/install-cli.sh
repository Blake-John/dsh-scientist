#!/usr/bin/env bash
# 把 cite-check 装成 PATH 上的命令（默认 ~/.local/bin/cite-check 符号链接）。
#
# 用法：bash scripts/install-cli.sh [目标目录]
# 卸载：rm ~/.local/bin/cite-check
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${1:-$HOME/.local/bin}"
TARGET="$BIN_DIR/cite-check"
# 链向包内脚本：link: 安装时包目录即源目录；npm 安装时包目录在 node_modules 下，
# 两种情况下这个路径都是稳定的（脚本随包走）。
SOURCE="$DIR/scripts/cite-check.mjs"
LIT_SOURCE="$DIR/scripts/lit.mjs"
LIB_SOURCE="$DIR/scripts/lit-lib.mjs"

mkdir -p "$BIN_DIR"
chmod +x "$SOURCE"
ln -sfn "$SOURCE" "$TARGET"

ln -sfn "$LIT_SOURCE" "$BIN_DIR/lit"
chmod +x "$LIT_SOURCE"

echo "已链接：$TARGET -> $SOURCE"
echo "已链接：$BIN_DIR/lit -> $LIT_SOURCE"
ln -sfn "$LIB_SOURCE" "$BIN_DIR/lit-lib"
chmod +x "$LIB_SOURCE"
echo "已链接：$BIN_DIR/lit-lib -> $LIB_SOURCE"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "PATH 已包含 $BIN_DIR，直接运行：cite-check --root ." ;;
  *) echo "注意：$BIN_DIR 不在 PATH 里，请加入 PATH 或用绝对路径 $TARGET" ;;
esac
