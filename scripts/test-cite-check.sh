#!/usr/bin/env bash
# cite-check 自测：造一个已知有问题的 fixture，断言检查器能抓出来；
# 再断言干净 fixture 返回 0。离线运行（--no-network），不依赖网络。
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$DIR/scripts/cite-check.mjs"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0

mkdir -p "$tmp/bad/literature" "$tmp/bad/reports"
cat > "$tmp/bad/literature/references.bib" <<'BIB'
@article{good2020,
  title = {A Fine Paper}, author = {Doe, Jane}, journal = {J. Test}, year = {2020},
  doi = {10.9999/not-real}
}
@article{missingauthor,
  title = {No Author Field}, journal = {J. Test}, year = {2021}
}
BIB
echo 'Text cites [@good2020] and [@ghost2099].' > "$tmp/bad/reports/r.md"

out_bad="$(node "$CHECK" --root "$tmp/bad" --no-network 2>&1)"
code_bad=$?
if [[ "$code_bad" -eq 0 ]]; then
  echo "✗ bad fixture 应返回非 0，实际 0"; fail=1
fi
for expected in "缺必填字段 author" "正文引用了不存在的 citekey: ghost2099"; do
  if ! grep -q "$expected" <<<"$out_bad"; then
    echo "✗ 未检出：$expected"; fail=1
  fi
done

mkdir -p "$tmp/good/literature" "$tmp/good/reports"
cat > "$tmp/good/literature/references.bib" <<'BIB'
@article{good2020,
  title = {A Fine Paper}, author = {Doe, Jane}, journal = {J. Test}, year = {2020},
  doi = {10.9999/not-real}
}
BIB
echo 'Text cites [@good2020].' > "$tmp/good/reports/r.md"

out_good="$(node "$CHECK" --root "$tmp/good" --no-network 2>&1)"
code_good=$?
if [[ "$code_good" -ne 0 ]]; then
  echo "✗ good fixture 应返回 0，实际 $code_good"; echo "$out_good" | sed 's/^/    /'; fail=1
fi

if [[ "$fail" -eq 0 ]]; then
  echo "✓ cite-check 自测通过（检出缺失字段、悬空 citekey；干净 fixture 通过）"
fi
exit "$fail"
