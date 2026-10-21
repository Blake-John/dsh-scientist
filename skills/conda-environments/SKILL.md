---
name: conda-environments
description: 用 conda/uv 管理可复现的计算环境：创建、固定版本、导出 yml/lock、恢复，并把环境文件接入工件溯源（record_save 的 envFile）。需要装包、换环境、保证结果可复现、或复现他人/历史分析时使用。
whenToUse: 新建分析环境、安装科学计算依赖、复现历史结果、需要固定 Python/CUDA/编译工具链版本时。
---

# 环境管理（Conda / uv Environments）

**环境是复现性的一半。** 没有锁定的环境，"跑出来了"就无法重来。

## 先看现状，别急着建

```bash
conda env list                 # 已有环境（本机：base / atom_calculations / costudio / pytorch）
python3 -c "import sys; print(sys.executable, sys.version)"
python3 -c "import numpy, sympy, pint, uncertainties, torch; print('ok')"
```

- 项目已有环境 → 用它，把环境名记进 `experiments/<id>/design.md`。
- 项目没有环境 → 见下节创建；**不要往 base 里装项目依赖**。
- 系统 `python3` 已有 numpy/scipy/sympy/matplotlib/pandas/pint/uncertainties/torch，
  临时脚本可以直接用；一旦要跑"要写进结论"的计算，就固化到项目环境。

## 创建环境

```bash
# 通用科学计算（推荐 conda-forge 单一通道，依赖解析冲突最少）
conda create -n <env-name> -c conda-forge python=3.11 numpy scipy sympy matplotlib pint uncertainties

# GPU / PyTorch：CUDA 版本必须显式钉住，否则换机器必然不一致
conda create -n <env-name> -c conda-forge python=3.11 pytorch-gpu=*=cuda* -c pytorch

# 编译型/特殊工具链（如量化化学、有限元）：先查 conda-forge 是否有，再考虑 pip 源码编译
```

- 环境名对应任务（如 `atom-calcs`、`ml-ablation`、`fem`）。
- 记录**通道**与安装命令，不要只写"我装了 X"。
- pip 与 conda 混用时：先 conda 装完，再 `pip install`，最后导出，避免互相覆盖。

## 固定与导出（每个环境必做）

```bash
conda activate <env-name>
conda env export --no-builds > envs/<env-name>.yml      # 人类可读
conda env export > envs/<env-name>.lock.yml             # 完整锁定（含 build 号）
# 纯 pip 环境：
uv pip freeze > envs/<env-name>.requirements.txt
```

- `envs/*.lock.yml` 是**复现基准**，入 git；更新依赖后重新导出并记 `envs/CHANGELOG.md`。
- CUDA / 驱动 / 编译器版本单独记一行（conda 锁不到驱动）。

## 接入工件溯源（关键）

`record_save` 支持 `env` 参数：把上面的锁文件传进去，工件就带上环境哈希。

```json
record_save({
  "name": "ablation-results-v1",
  "sources": ["results/ablation.csv"],
  "command": "python experiments/E03/code/run_ablation.py --seeds 0-9",
  "inputs": ["data/manifest.tsv"],
  "envFile": "envs/ml-ablation.lock.yml"
})
```

**任何"要写进结论"的结果，归档时必须带 envFile。** 没带 = 复现链断在环境这一环。

## 恢复

```bash
conda env create -f envs/<env-name>.lock.yml
# 或
uv venv .venv && uv pip sync envs/<env-name>.requirements.txt
```

恢复后跑冒烟测试（`python -c "import <关键包>"`、`nvidia-smi`、工具 `--version`），
把输出贴进实验 `log.md`。

## 复现失败排查顺序

**环境 → 数据版本 → 随机种子 → 参数 → 代码版本**。先确认环境一致，再怀疑算法。

## 纪律

- 每个项目独立环境；base 只放公共工具。
- 随机性必须钉住：`PYTHONHASHSEED`、`numpy.random.seed`、框架 seed、DataLoader worker seed。
- 长任务用 `tool-jobs` 后台跑，日志落 `experiments/<id>/logs/`。
- 跨机器复现时把锁文件路径写进 `record_save` 的 `env` 参数，并在笔记里记下该机器的激活方式（本 preset 不含远程执行工具）。
