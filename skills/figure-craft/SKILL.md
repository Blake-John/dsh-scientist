---
name: figure-craft
description: 科研出图规范——图是工件不是截图：可重跑的出图脚本、矢量输出、字号与线宽下限、色盲友好配色、误差棒含义标注、caption 四要素。任何要进报告/论文/组会的图都用此技能。
whenToUse: 画结果图、对比图、示意图、误差棒/分布图、论文插图排版时。
---

# 出图规范（Figure Craft）

**图 = 代码 + 数据 + 输出。** 手工调出来的图不可复现，等于没有。

> 本技能只管**数据图**（曲线/散点/误差棒/分布/热图）。
> 流程图、状态机、依赖图、网络拓扑、论文级示意图 → 用 `diagram-craft` 选型（Mermaid / Graphviz / TikZ）。
> 误差棒该画 SD 还是 SEM、要不要校正、怎么报 p → 用 `stats-and-inference`。

## 目录与产物

```
outputs/figures/<name>/
  plot.py          出图脚本（读 data/ 或 results/，只写本目录）
  <name>.pdf       矢量主产物（论文/报告用这个）
  <name>.svg       备选矢量（可编辑）
  <name>.png       300 dpi 预览（聊天/幻灯片用）
  caption.md       图注（四要素）
```

`plot.py` 必须能一条命令重跑并产出完全相同的图：
`python outputs/figures/<name>/plot.py`；随机过程钉住 seed；不要依赖交互式操作。

## 基础样式（matplotlib 模板）

```python
import matplotlib as mpl
import matplotlib.pyplot as plt

mpl.rcParams.update({
    "figure.dpi": 150, "savefig.dpi": 300,
    "savefig.bbox": "tight", "savefig.transparent": False,
    "font.size": 9, "axes.titlesize": 10, "axes.labelsize": 9,
    "xtick.labelsize": 8, "ytick.labelsize": 8, "legend.fontsize": 8,
    "axes.linewidth": 0.8, "lines.linewidth": 1.4, "lines.markersize": 4,
    "axes.grid": True, "grid.linewidth": 0.4, "grid.alpha": 0.35,
    "axes.spines.top": False, "axes.spines.right": False,
    "figure.figsize": (3.4, 2.6),          # 单栏宽 ~3.4 in；双栏 ~7.0 in
    "axes.prop_cycle": mpl.cycler(color=[
        "#0072B2", "#D55E00", "#009E73", "#CC79A7",
        "#E69F00", "#56B4E9", "#000000", "#F0E442"]),  # Okabe-Ito 色盲友好
})

fig, ax = plt.subplots()
ax.plot(x, y, label="method A")
ax.set_xlabel("time $t$ [s]")
ax.set_ylabel(r"energy $E$ [J]")
ax.legend(frameon=False)
fig.savefig("outputs/figures/<name>/<name>.pdf")
```

- 字号下限：正文 9 pt、刻度 8 pt；**缩到单栏宽度后仍要能看清**。
- 线宽 0.8–1.5，不要细于 0.5。
- 单位写进轴标签方括号：`[s]`、`[J]`、`[m/s]`；量用斜体符号，别写中文变量名。
- 颜色只用色盲友好序列（Okabe-Ito / viridis / cividis）；**不要用彩虹色（jet）**。
- 打印友好：黑白打印也要能靠线型/标记区分（`linestyle` + `marker` 组合）。

## 选图原则

| 要表达 | 用 | 不要用 |
| --- | --- | --- |
| 中心趋势 + 不确定性 | 均值±标准差/标准误误差棒，或箱线/小提琴 | 只有柱子的柱状图（掩盖分布） |
| 分布形状 | 直方图/核密度/小提琴（标样本量 n） | 无 n 的平滑曲线 |
| 两量关系 | 散点 + 拟合线（标 R²/残差） | 连点折线（暗示不存在的连续性） |
| 跨数量级 | 对数轴（明确标注 log） | 线性轴压扁小值 |
| 多组对比 | 分面（subplots）或点线图 | 双 Y 轴（极易误导） |
| 时间演化 | 折线 + 阴影带 | 3D 曲面、3D 饼图 |

## 图注（caption）四要素

1. **画的是什么**（变量、组别、条件）
2. **轴与单位**，对数轴要写明
3. **误差棒/阴影的含义**（SD？SEM？95% CI？n=？）——不写等于没说
4. **数据来源**（`data/…` + 工件名与版本 + 出图脚本路径）

示例：
> 图 3：不同温度下反应速率常数（均值 ± 1 SD，n=5 次独立模拟）。横轴温度 [K]，
> 纵轴 k [s⁻¹]，纵轴为对数刻度。数据 `results/rates.csv`，工件 `rates-v2`，
> 脚本 `outputs/figures/rate-vs-T/plot.py`。

## 验收清单

- [ ] `python outputs/figures/<name>/plot.py` 能重跑并产出同名 pdf/svg/png
- [ ] 轴标签带单位；对数轴已标注
- [ ] 误差棒含义写在 caption 里（或图例里）
- [ ] 色盲友好 + 黑白可辨（线型/标记有区分）
- [ ] 单栏缩放到 3.4 in 宽度后文字仍可读
- [ ] caption 四要素齐全，引用了数据与工件
- [ ] 没有截断坐标轴、没有双 Y 轴、没有 3D 装饰
- [ ] `record_save` 归档 `outputs/figures/<name>/`（sources 含 plot.py 与数据路径）

## 常见坑

- **y 轴不从 0 开始却不说明**：比较量级时误导，必须在 caption 写明或改用比值图。
- **误差棒含义不明**：SD / SEM / CI 混用，读者无法判断。
- **不同实验设置的数字画进同一张图**：不可比的数据不要并排。
- **截图代替出图**：不可复现、不可改字号、论文投稿被拒。
- **颜色过多**：超过 6 个类别改用分面或直接标注，别靠颜色区分。
