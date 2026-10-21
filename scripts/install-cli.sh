#!/usr/bin/env bash
# 把本包的命令行工具链接到 PATH（默认 ~/.local/bin）。
#
#   lit          文献检索 / DOI 元数据 / BibTeX / 取全文
#   lit-lib      受控词表的文献库（入库、校验、检索、导出）
#   cite-check   引用与可复现性检查（--deep 做研究链路全链校验）
#   vault        科研记录运维（index/list/show/diff/deprecate/prune/export）
#
# 用法：bash scripts/install-cli.sh [目标目录]
# 卸载：rm ~/.local/bin/{lit,lit-lib,cite-check,vault}
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${1:-$HOME/.local/bin}"

# 命令名 → 包内脚本（随包发布；link: 与 npm 安装两种情况下路径都稳定）
CLI_NAMES=(lit lit-lib cite-check vault)
CLI_PATHS=(
  scripts/lit.mjs
  scripts/lit-lib.mjs
  scripts/cite-check.mjs
  scripts/vault.mjs
)

mkdir -p "$BIN_DIR"
for i in "${!CLI_NAMES[@]}"; do
  name="${CLI_NAMES[$i]}"
  rel="${CLI_PATHS[$i]}"
  src="$DIR/$rel"
  if [ ! -f "$src" ]; then
    echo "✗ 缺少 $rel，跳过 $name" >&2
    continue
  fi
  chmod +x "$src"
  ln -sfn "$src" "$BIN_DIR/$name"
  echo "已链接：$BIN_DIR/$name -> $src"
done

case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo
    echo "PATH 已包含 $BIN_DIR，可直接运行：vault list / cite-check --deep / lit --help"
    ;;
  *)
    echo
    echo "注意：$BIN_DIR 不在 PATH 里，请把它加入 PATH（或把 $BIN_DIR 换成已在 PATH 的目录）。"
    ;;
esac
