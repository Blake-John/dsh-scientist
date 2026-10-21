#!/usr/bin/env bash
# 一键验收：结构 / loader 方言 / roster / cite-check / bundle patch / 技能 provider /
#             文献工具（离线）+ 可选联网实测
#
# 用法：
#   bash scripts/verify.sh            # 离线检查（不联网）
#   bash scripts/verify.sh --live     # 额外跑 lit 的联网实测（约 40–60s）
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

fail=0
run() {
  echo
  echo "▶ $1"
  shift
  if "$@"; then echo "  ✓ pass"; else echo "  ✗ FAIL"; fail=1; fi
}

run "结构校验（preset.yml / 插件行 / 技能 frontmatter）" python3 scripts/validate.py
run "loader 方言校验（真实 entryListSchema 解析 agent.cordis.yml）" node scripts/check-loader.mjs agent.cordis.yml
run "roster 校验（~/.dsh/.agent-presets 下每个 preset 可解析）" node scripts/check-roster.mjs
run "cite-check 自测（悬空 citekey / 缺失字段应被抓出）" bash scripts/test-cite-check.sh
run "bundle patch 与源组合一致" node scripts/build-patch.mjs --check
run "bundle patch 注册校验（preset 行 / 技能 provider / lit-tools）" node scripts/check-patch.mjs
run "skills-provider 单测（frontmatter + 候选 + 正文）" node scripts/test-skills-provider.mjs
run "lit-core 单测（citekey / BibTeX / 去重 / PDF 校验）" node scripts/test-lit-core.mjs
run "lit-tools 结构测试（4 个工具 + 契约字段）" node scripts/test-lit-tools.mjs
run "pdf-tools 测试（画像 / markdown / text / render）" node scripts/test-pdf-tools.mjs
run "lit-lib 测试（frontmatter / 校验 / 过滤 / CLI 流程）" node scripts/test-lit-lib.mjs
run "vault-core 单测（锁 / 原子写 / 哈希 / 硬链接 / 遍历）" node scripts/test-vault-core.mjs
run "vault-record 测试（保存 / 去重 / 校验 / 复现）" node scripts/test-vault-record.mjs
run "vault-study 测试（状态机 / 归档 / 决策 / 评审 / 回退）" node scripts/test-vault-study.mjs

if [[ "${1:-}" == "--live" ]]; then
  run "lit-tools 联网实测（lit_doi / lit_search / lit_bib / lit_pdf ×2）" node scripts/test-lit-tools.mjs --live
  run "文献源可用性实测（lit doctor）" node scripts/lit.mjs doctor
else
  echo
  echo "▶ 联网实测：已跳过（加 --live 运行）"
fi

echo
if [[ "$fail" -eq 0 ]]; then
  echo "全部通过。装/更新：dsh plugin --profile web add link:$DIR  然后重启 dsh web。"
else
  echo "有检查未通过，见上面 ✗ 行。"
fi
exit "$fail"
