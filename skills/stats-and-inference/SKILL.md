---
name: stats-and-inference
description: 统计检验与结果报告规范——检验选型、假设检查、多重比较校正、bootstrap 置信区间、效应量，以及计算/ML 实验的多种子与配对比较。任何要写"显著/不显著""均值±误差""n 次实验"的结论前都用此技能。
whenToUse: 比较两组或多组结果、判断差异是否显著、报告误差棒、做消融/多种子实验、审读他人统计结论时。
---

# 统计检验与结果报告

原则：**先定检验再跑数据，先报效应量再报 p。** p 值只回答"是否可能偶然"，不回答"有多大用"。

## 报告五要素（缺一不可）

1. **n**（每组独立样本数；重复次数 ≠ 样本数）
2. **集中趋势 + 离散度**：均值 ± SD（描述数据）或 ± SEM/95% CI（描述估计），**必须写明是哪个**
3. **效应量**：Cohen's d、Hedges' g、η²、r、比值比、或直接给差值及其 CI
4. **检验名 + 统计量 + p**：`Welch t(28) = 3.12, p = .004`
5. **前提假设是否满足**，不满足时用了什么替代（非参数 / 校正）

## 检验选型

| 场景 | 首选 | 前提不满足 / 数据非正态 |
|---|---|---|
| 两组独立 | Welch t 检验（`equal_var=False`） | Mann-Whitney U |
| 两组配对（同一对象前后） | 配对 t 检验 | Wilcoxon 符号秩 |
| 三组以上 | 单因素 ANOVA + 事后检验 | Kruskal-Wallis + Dunn |
| 两变量关系 | Pearson r | Spearman ρ |
| 比例/列联表 | 卡方 | Fisher 精确检验（小样本） |
| 差值/比值的区间 | **bootstrap 95% CI** | 同上（bootstrap 不依赖正态） |

**默认用 Welch，不用等方差 t 检验**——等方差假设几乎总是多余且脆弱。

## 假设检查（决定用哪条路）

```python
from scipy import stats
stats.shapiro(x)              # 正态性（n<50 才有意义）
stats.levene(a, b)            # 方差齐性
# 小样本或明显偏态 → 直接上非参数，别硬套 t 检验
```

## 多重比较必须校正

比较 k 组做 k 次检验时，族错误率会爆炸。规则：

- **只报一个预先指定的比较** → 不用校正，但要在方法里写明"预先指定"。
- **事后扫描、多指标、多数据集** → 校正。优先 **Holm**（控制 FWER，比 Bonferroni 有力）或 **Benjamini–Hochberg**（控制 FDR，探索性分析常用）。

```python
from scipy.stats import false_discovery_control
p_adj = false_discovery_control([0.01, 0.04, 0.03, 0.20], method='bh')
```

## Bootstrap 置信区间（推荐的通用做法）

```python
import numpy as np
from scipy import stats

rng = np.random.default_rng(0)
a, b = rng.normal(1.0, 1, 30), rng.normal(1.6, 1, 30)

# ⚠️ 两样本时 statistic 必须接受两个位置参数 (x, y)，否则会报
#    "got multiple values for argument 'axis'"
def diff_means(x, y, axis=-1):
    return np.mean(x, axis=axis) - np.mean(y, axis=axis)

res = stats.bootstrap((a, b), diff_means, n_resamples=5000,
                      random_state=0, vectorized=True)
print(res.confidence_interval)     # 差值及其 95% CI
```

- 报告格式：`Δ = 0.62 [95% CI 0.54, 1.42]`，CI 跨 0 即"无证据支持差异"，不要写成"证明没有差异"。
- 随机种子写进方法与代码；bootstrap 次数 ≥5000。

## 计算 / ML 实验的额外纪律

- **多种子**：至少 3–5 个随机种子，报 mean ± std（或 median/IQR），**绝不报 best-of-n**。
- **配对比较**：同一数据划分/同一种子下的两个方法用配对检验（配对 t 或 Wilcoxon），比独立检验敏感得多。
- **记录**：种子、数据版本、环境（`envs/*.lock.yml`）、每轮指标 → 归档进工件。
- **消融**：一次只改一个因素；改两个因素就无法归因。
- **不要用测试集调参**；报告最终数字时明确"该结果是否用于选型"。
- 训练曲线抖动大时，报"最后 k 轮均值"并说明 k。

## 报告模板

```markdown
### 统计结果
| 方法 | n | 指标（mean ± SD） | 95% CI | vs 基线 |
|---|---|---|---|---|
| baseline | 5 | 71.2 ± 1.8 | [69.9, 72.5] | — |
| ours | 5 | 74.6 ± 1.1 | [73.8, 75.4] | +3.4 [2.2, 4.6] |

配对 Wilcoxon 检验（5 个种子，同一数据划分）：W = 0, p = .062, r = .89（效应量大但样本小）。
结论：方向一致但证据不足，需增加种子数。
```

方法段要写：检验名、单/双侧、是否校正、n 的定义、软件版本。

## 常见错误

- **只报 p 不报效应量**：n 很大时 0.1% 的差异也"显著"。
- **SD 与 SEM 混用**：SEM = SD/√n，常被用来把误差棒画小；必须在图注写明。
- **n=3 就下结论**：小样本 + 事后选最优 = 几乎必然假阳性。
- **多重比较不校正**：扫了 10 个指标，报最显著那个。
- **p > .05 写成"没有差异"**：只能说"无证据支持差异"（尤其小样本）。
- **正态性检验当教条**：n 大时 shapiro 几乎必然拒绝；看分布形态与量级，必要时直接用稳健方法。
- **误差棒没说是 SD/SEM/CI**：读者无法判断。

## 与出图的联动

误差棒、箱线、CI 带的画法见 `figure-craft`；**图注必须写明误差棒含义与 n**，图与表的统计口径必须一致（同一份结果数据生成）。
