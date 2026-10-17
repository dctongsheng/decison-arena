# 贪吃蛇 Harness A/B/C 实验报告

开发预实验、独立验收与重复实验分别列出。种子序号按预先登记的 schedule 顺序，原始种子见 [seeds.json](seeds.json)；不按得分或完成时间重排。

规则：snake-realtime-v2；提示协议：decision-arena-arcade-v4。

- A：snake-harness-a-v1
- B：snake-harness-b-v1
- C：snake-harness-c-v1

默认仍为 A；本报告不会自动改变默认。单一 Jev 模型达到门槛也不足以推断其他模型应切换。正式批次暂停/失败：否。

源代码 SHA-256：af32f92856958dd41ea948b5a6b7bde59a14848f5c3e59511491808d3f8e958c；计划 SHA-256：28383681077b56c46e5d9e0f6a2d05c47689d30d75e312c7a41edf7a18fc4541。

统计采用固定随机种子、10000 次配对重采样，分别报告 B−A、C−A 的 97.5% 双侧区间；这是 nominal Bonferroni familywise target 0.05 的 bootstrap 近似，并非有限样本覆盖保证。延迟和时序指标使用 R7 分位数。

原规则先比较食物，再比较生存 tick（60 tick/s）。无效、缺失、异常局不按 0 分处理。重复实验不作为独立样本进入置信区间。applied tick 表示输入已进入下一物理步，不等于蛇已完成转向；后续输入可覆盖排队转向。

## 全部请求与证据完整性

### 开发预实验

请求 28；可核对 decision 28；缺失 0；错误局 0；无效回放 0。

applied / dropped / failed / unknown：25 / 3 / 0 / 0。延迟 R7 中位数 / P95：814.5 / 1296.3 ms（n=28）。

观察→settled tick 中位数 / P95：48.5 / 61.65；移动格数：2 / 3。

观察→applied tick 中位数 / P95：50 / 62.8；移动格数：3 / 3。

最长无得分移动：37 格；完整状态循环总数：0；重复状态访问总数：0。

thoughtUsed true / false / 未返回：0 / 0 / 28。

### 正式独立与重复实验

请求 995；可核对 decision 995；缺失 0；错误局 0；无效回放 0。

applied / dropped / failed / unknown：921 / 74 / 0 / 0。延迟 R7 中位数 / P95：898 / 1559.6 ms（n=995）。

观察→settled tick 中位数 / P95：53 / 90.3；移动格数：3 / 5。

观察→applied tick 中位数 / P95：55 / 91；移动格数：3 / 5。

最长无得分移动：120 格；完整状态循环总数：16；重复状态访问总数：122。

thoughtUsed true / false / 未返回：0 / 0 / 995。

## 未纳入评分的外部阻塞

StartLux / System One：HTTP 401。未纳入评分或置信区间，也不按 0 分、失败局或模型能力结论处理。此记录由发布命令显式提供；渲染器未读取凭证或发起验证请求。

## 模型 1：typesafe/jev-1.13

提供商：openrouter；实际返回模型：typesafe/jev-1.13-20260917；请求思考配置：never。

### 开发预实验（不参与验收）

| 种子序号 | A：食物 / 生存 tick | B：食物 / 生存 tick | C：食物 / 生存 tick | B−A 原规则 | C−A 原规则 |
|---|---|---|---|---|---|
| 01 | 0 / 760（12.667s；WALL_COLLISION） | 0 / 300（5s；WALL_COLLISION） | 1 / 400（6.667s；WALL_COLLISION） | 未判定 | 未判定 |

请求 28；可核对 decision 28；缺失 0；错误局 0；无效回放 0。

applied / dropped / failed / unknown：25 / 3 / 0 / 0。延迟 R7 中位数 / P95：814.5 / 1296.3 ms（n=28）。

观察→settled tick 中位数 / P95：48.5 / 61.65；移动格数：2 / 3。

观察→applied tick 中位数 / P95：50 / 62.8；移动格数：3 / 3。

最长无得分移动：37 格；完整状态循环总数：0；重复状态访问总数：0。

thoughtUsed true / false / 未返回：0 / 0 / 28。

### 20 个独立种子

| 种子序号 | A：食物 / 生存 tick | B：食物 / 生存 tick | C：食物 / 生存 tick | B−A 原规则 | C−A 原规则 |
|---|---|---|---|---|---|
| 01 | 2 / 1020（17s；WALL_COLLISION） | 2 / 800（13.333s；WALL_COLLISION） | 0 / 1440（24s；WALL_COLLISION） | −1 | −1 |
| 02 | 2 / 1280（21.333s；WALL_COLLISION） | 1 / 820（13.667s；WALL_COLLISION） | 0 / 1340（22.333s；WALL_COLLISION） | −1 | −1 |
| 03 | 1 / 420（7s；WALL_COLLISION） | 0 / 320（5.333s；WALL_COLLISION） | 0 / 1180（19.667s；WALL_COLLISION） | −1 | −1 |
| 04 | 1 / 440（7.333s；WALL_COLLISION） | 0 / 1500（25s；WALL_COLLISION） | 0 / 420（7s；WALL_COLLISION） | −1 | −1 |
| 05 | 0 / 360（6s；WALL_COLLISION） | 0 / 360（6s；WALL_COLLISION） | 0 / 280（4.667s；WALL_COLLISION） | 0 | −1 |
| 06 | 0 / 960（16s；WALL_COLLISION） | 0 / 340（5.667s；WALL_COLLISION） | 0 / 720（12s；WALL_COLLISION） | −1 | −1 |
| 07 | 0 / 780（13s；WALL_COLLISION） | 0 / 1180（19.667s；WALL_COLLISION） | 0 / 260（4.333s；WALL_COLLISION） | +1 | −1 |
| 08 | 2 / 1000（16.667s；WALL_COLLISION） | 1 / 1440（24s；WALL_COLLISION） | 0 / 1360（22.667s；WALL_COLLISION） | −1 | −1 |
| 09 | 1 / 500（8.333s；WALL_COLLISION） | 1 / 440（7.333s；WALL_COLLISION） | 1 / 380（6.333s；WALL_COLLISION） | −1 | −1 |
| 10 | 0 / 900（15s；WALL_COLLISION） | 1 / 1880（31.333s；WALL_COLLISION） | 0 / 320（5.333s；WALL_COLLISION） | +1 | −1 |
| 11 | 2 / 700（11.667s；WALL_COLLISION） | 0 / 2100（35s；WALL_COLLISION） | 2 / 2720（45.333s；WALL_COLLISION） | −1 | +1 |
| 12 | 1 / 2600（43.333s；WALL_COLLISION） | 0 / 660（11s；WALL_COLLISION） | 0 / 260（4.333s；WALL_COLLISION） | −1 | −1 |
| 13 | 0 / 300（5s；WALL_COLLISION） | 0 / 340（5.667s；WALL_COLLISION） | 1 / 420（7s；WALL_COLLISION） | +1 | +1 |
| 14 | 1 / 1280（21.333s；WALL_COLLISION） | 1 / 440（7.333s；WALL_COLLISION） | 0 / 420（7s；WALL_COLLISION） | −1 | −1 |
| 15 | 0 / 360（6s；WALL_COLLISION） | 0 / 360（6s；WALL_COLLISION） | 0 / 420（7s；WALL_COLLISION） | 0 | +1 |
| 16 | 1 / 380（6.333s；WALL_COLLISION） | 0 / 380（6.333s；WALL_COLLISION） | 0 / 520（8.667s；WALL_COLLISION） | −1 | −1 |
| 17 | 2 / 1060（17.667s；WALL_COLLISION） | 0 / 1200（20s；WALL_COLLISION） | 0 / 420（7s；WALL_COLLISION） | −1 | −1 |
| 18 | 0 / 560（9.333s；WALL_COLLISION） | 0 / 1500（25s；WALL_COLLISION） | 1 / 1540（25.667s；WALL_COLLISION） | +1 | +1 |
| 19 | 0 / 460（7.667s；WALL_COLLISION） | 1 / 980（16.333s；WALL_COLLISION） | 0 / 320（5.333s；WALL_COLLISION） | +1 | −1 |
| 20 | 0 / 900（15s；WALL_COLLISION） | 1 / 1600（26.667s；WALL_COLLISION） | 0 / 260（4.333s；WALL_COLLISION） | +1 | −1 |

请求 826；可核对 decision 826；缺失 0；错误局 0；无效回放 0。

applied / dropped / failed / unknown：767 / 59 / 0 / 0。延迟 R7 中位数 / P95：887 / 1445.25 ms（n=826）。

观察→settled tick 中位数 / P95：53 / 86；移动格数：3 / 4。

观察→applied tick 中位数 / P95：54 / 87；移动格数：3 / 4。

最长无得分移动：120 格；完整状态循环总数：14；重复状态访问总数：101。

thoughtUsed true / false / 未返回：0 / 0 / 826。

| 版本 | 平均食物 | 平均生存 tick | 请求 | drop | 延迟中位数 / P95 ms |
|---|---|---|---|---|---|
| A | 0.8 | 813 | 271 | 20 | 903 / 1460 |
| B | 0.45 | 932 | 298 | 19 | 891 / 1466.65 |
| C | 0.25 | 750 | 257 | 20 | 877 / 1358 |

### 5 个重复种子（仅描述波动）

| 种子序号 | A：食物 / 生存 tick | B：食物 / 生存 tick | C：食物 / 生存 tick | B−A 原规则 | C−A 原规则 |
|---|---|---|---|---|---|
| 01 | 2 / 2900（48.333s；WALL_COLLISION） | 2 / 860（14.333s；WALL_COLLISION） | 0 / 360（6s；WALL_COLLISION） | −1 | −1 |
| 05 | 0 / 1200（20s；WALL_COLLISION） | 1 / 340（5.667s；WALL_COLLISION） | 0 / 260（4.333s；WALL_COLLISION） | +1 | −1 |
| 09 | 1 / 840（14s；WALL_COLLISION） | 2 / 420（7s；WALL_COLLISION） | 1 / 380（6.333s；WALL_COLLISION） | +1 | −1 |
| 13 | 0 / 360（6s；WALL_COLLISION） | 0 / 380（6.333s；WALL_COLLISION） | 1 / 420（7s；WALL_COLLISION） | +1 | +1 |
| 17 | 0 / 560（9.333s；WALL_COLLISION） | 0 / 520（8.667s；WALL_COLLISION） | 0 / 1520（25.333s；WALL_COLLISION） | −1 | +1 |

请求 169；可核对 decision 169；缺失 0；错误局 0；无效回放 0。

applied / dropped / failed / unknown：154 / 15 / 0 / 0。延迟 R7 中位数 / P95：947 / 1875.2 ms（n=169）。

观察→settled tick 中位数 / P95：56 / 106；移动格数：3 / 5。

观察→applied tick 中位数 / P95：57.5 / 107；移动格数：3 / 5。

最长无得分移动：81 格；完整状态循环总数：2；重复状态访问总数：21。

thoughtUsed true / false / 未返回：0 / 0 / 169。

| 种子序号 | 版本 | 重复−原始食物 | 重复−原始生存 tick |
|---|---|---|---|
| 01 | A | 0 | 1880 |
| 01 | B | 0 | 60 |
| 01 | C | 0 | -1080 |
| 09 | A | 0 | 340 |
| 09 | B | 1 | -20 |
| 09 | C | 0 | 0 |
| 17 | A | -2 | -500 |
| 17 | B | 0 | -680 |
| 17 | C | 0 | 1100 |
| 13 | A | 0 | 60 |
| 13 | B | 0 | 40 |
| 13 | C | 0 | 0 |
| 05 | A | 0 | 840 |
| 05 | B | 1 | -20 |
| 05 | C | 0 | -20 |

### 预先指定的联合门槛

| 比较 | 食物均差 | 97.5% CI | CI 下界 | 原规则净胜 | 重复均差 | 重复差值 min / max | 联合门槛 |
|---|---|---|---|---|---|---|---|
| B minus A | -0.35 | -0.8 ～ 0.05 | -0.8 | -6 | 0.4 | 0 / 1 | 未通过 |
| C minus A | -0.55 | -1 ～ -0.1 | -1 | -12 | -0.2 | -2 / 1 | 未通过 |

只有全部满足才通过：20 个独立种子完整、5 个重复种子完整、正式局无错误且回放校验通过、食物均差 ≥0.5、CI 下界 >0、原规则净胜 ≥0、重复配对食物均差 ≥0。

B minus A 未通过项：meanFoodImprovementAtLeastHalf, confidenceLowerBoundAboveZero, originalRuleNetWinsNonnegative。

C minus A 未通过项：meanFoodImprovementAtLeastHalf, confidenceLowerBoundAboveZero, originalRuleNetWinsNonnegative, repeatedMeanFoodDifferenceNonnegative。

汇总报告仅含白名单指标，不包含私有接口地址、凭证、用户/会话 ID、原始请求、思考正文或完整回放。独立 .events.json 保留格式校验后的 session ID 和逐调用时序用于本地核对；私有对局仍需所有者登录才能读取。
