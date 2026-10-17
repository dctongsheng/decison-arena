# Jev 正式验收后的 Snake 轨迹解释

日期：2026-10-17。本页在全部 75 局结束后编写，只解释已发生的行为，不修改实验指令、候选、种子、计分或发布门槛。正式成绩仍以原报告及预声明为准。

固定选择 [seeds.json](./seeds.json) 的第一个 acceptance seed：`snake-accept-42c3abe410c74c38b6daaf19`，对应原报告 `run-0001` / `run-0002` / `run-0003`。此选择按清单位置，不按分数。三局均为独立验收样本；请求模型 `typesafe/jev-1.13`，实际返回模型 `typesafe/jev-1.13-20260917`，provider 为 OpenRouter，规则 `snake-realtime-v2`，协议 `decision-arena-arcade-v4`，请求策略要求关闭思考。服务商的 thoughtUsed 遥测未返回，不能据此确认上游内部计算状态。

## 三局概况

| 版本 | session ID | Harness | 调用数 | 食物 / 分数 | 死亡 tick / 秒 | 结束原因 |
|---|---|---|---:|---|---|---|
| A | `arcade-b5791815-a0e6-40c2-a8dc-9ba959a6cf2b` | `snake-harness-a-v1` | 18 | 2 / 200 | 1020 / 17 | WALL_COLLISION |
| B | `arcade-dac04f02-7824-4ead-8123-ffdf1d86cbbc` | `snake-harness-b-v1` | 13 | 2 / 200 | 800 / 13.3333 | WALL_COLLISION |
| C | `arcade-4ad95679-c6e8-4df3-a1b4-dd5797b6b528` | `snake-harness-c-v1` | 24 | 0 / 0 | 1440 / 24 | WALL_COLLISION |

三局共 110 个已存帧、52 对 decision/input 映射均与逐 tick 重建一致，最终游戏状态也一致。未发现已接受动作被替换、下一请求早于前一动作的 appliedTick、或帧重建偏差。上述检查证明存储事件与当前冻结规则一致，不等于独立验证了上游模型内部计算。

## 时间和状态字段怎么读

- `observedTick`：形成该次模型观察时的仿真 tick。坐标从 `(0,0)` 开始，x 向右、y 向下，范围均为 0..19。
- `direction → queued`：观察时正在前进的方向与已排队方向。queued 在下一移动 tick 生效，不需要第二次确认；100ms 松键不会让蛇停止，也不会取消已排队转向。
- `settledTick`：保存 decision 事件时的会话 tick，即审计 JSON 的 `returnTick`。它不是独立测量的 HTTP arrival；终局后会话时钟冻结，甚至可停在超过实际死亡 tick 的批次末尾。
- `wall settlement tick`：用单次不中断运行的时钟锚点换算事件写入墙钟。它仅辅助说明终局后的结算时间，也不是 HTTP arrival。
- `appliedTick`：接受输入后的下一物理帧。物理仿真 60Hz，但蛇每 20 tick 才移动一格；因此 appliedTick 不等于蛇实际转向/移动的 tick。
- `成功移动/尝试`：从观察之后到结算 tick 的成功移动数 / 移动尝试数；撞墙的最后一次尝试不移动蛇头，计入后者。
- `elapsedMs`：provider 中从 fetch 开始到读取、解析响应的记录耗时，不含全部请求前准备与响应后凭证校验。没有独立 HTTP 到达、解析完成、凭证复核的分段时间，不能进一步归因到某一个网络或模型阶段。

下文动作均为原始 `方向:100`，没有合并、修正或补充动作。下一实际移动列指该已接受输入之后的第一个移动 tick；丢弃答案没有该项。

## A：末六次连续决策

Session：`arcade-b5791815-a0e6-40c2-a8dc-9ba959a6cf2b`。下表保留原决策序号，没有挑掉中间请求。

| # | observedTick | 蛇头 | direction → queued | 观察中的食物 | 模型选择 |
|---:|---:|---|---|---|---|
| 13 | 686 | (4,8) | down → down | (6,10) | `right:100` |
| 14 | 738 | (4,10) | down → right | (6,10) | `right:100` |
| 15 | 790 | (7,10) | right → right | (8,18) | `down:100` |
| 16 | 839 | (9,10) | right → down | (8,18) | `down:100` |
| 17 | 921 | (9,15) | down → down | (8,18) | `down:100` |
| 18 | 989 | (9,18) | down → down | (8,18) | `left:100` |

| # | settledTick | wall settlement tick | 结算时蛇头 | appliedTick | 成功移动 / 尝试 | 下一实际移动 tick / 方向 / 蛇头 | elapsedMs |
|---:|---:|---:|---|---:|---|---|---:|
| 13 | 737 | 738 | (4,10) | 738 | 2 / 2 | 740 / right / (5,10) | 855 |
| 14 | 787 | 787 | (7,10) | 788 | 3 / 3 | 800 / right / (8,10) | 809 |
| 15 | 836 | 836 | (9,10) | 837 | 2 / 2 | 840 / down / (9,11) | 773 |
| 16 | 919 | 919 | (9,14) | 920 | 4 / 4 | 920 / down / (9,15) | 1331 |
| 17 | 986 | 986 | (9,18) | 987 | 3 / 3 | 1000 / down / (9,19) | 1076 |
| 18 | 1022 | 1037 | (9,19) | — | 1 / 2 | 丢弃，未执行 | 805 |

第 13 次在 tick 686 观察到 `(4,8)` 正向下、食物 `(6,10)`，选择向右。等待期间先向下两格到 `(4,10)`；737 接受向右，738 成为 appliedTick，真正向右从 740 开始。第 14 次在 738 看到 direction 仍为 down、queued 已是 right，再次选择 right。它等待期间，蛇在 740 到 `(5,10)`、760 到 `(6,10)` 吃食物、780 到 `(7,10)`；食物随后变成 `(8,18)`。重复 queued 是可见行为，不能据此认定模型把它误解为“尚未确认”。

第 15 次选择 down，但响应前仍向右推进到 `(9,10)`，840 才向下。第 16 次观察到 right→down 又选择 down；第 17 次从 `(9,15)` 继续选择 down，等待期间到了 `(9,18)`。此时食物在左侧 `(8,18)`，继续向下会错过该行。

第 18 次于 989 观察 `(9,18)` 后选择 left。蛇先在 1000 到 `(9,19)`，1020 撞墙；该答案在会话 tick 1022 结算，墙钟换算约 1037，已丢弃。观察到死亡剩 31 tick，约 517ms，记录 elapsed 为 805ms。可以确认该次左转没有执行，不能把最终向下归因于“系统把 left 执行成 down”。

## B：末六次连续决策

Session：`arcade-dac04f02-7824-4ead-8123-ffdf1d86cbbc`。下表保留原决策序号，没有挑掉中间请求。

| # | observedTick | 蛇头 | direction → queued | 观察中的食物 | 模型选择 |
|---:|---:|---|---|---|---|
| 8 | 376 | (12,10) | down → left | (6,10) | `left:100` |
| 9 | 430 | (9,10) | left → left | (6,10) | `left:100` |
| 10 | 479 | (7,10) | left → left | (6,10) | `left:100` |
| 11 | 562 | (2,10) | left → left | (8,18) | `down:100` |
| 12 | 611 | (0,10) | left → down | (8,18) | `down:100` |
| 13 | 757 | (0,17) | down → down | (8,18) | `right:100` |

| # | settledTick | wall settlement tick | 结算时蛇头 | appliedTick | 成功移动 / 尝试 | 下一实际移动 tick / 方向 / 蛇头 | elapsedMs |
|---:|---:|---:|---|---:|---|---|---:|
| 8 | 429 | 429 | (9,10) | 430 | 3 / 3 | 440 / left / (8,10) | 885 |
| 9 | 478 | 478 | (7,10) | 479 | 2 / 2 | 480 / left / (6,10) | 787 |
| 10 | 559 | 559 | (3,10) | 560 | 4 / 4 | 560 / left / (2,10) | 1318 |
| 11 | 610 | 610 | (0,10) | 611 | 2 / 2 | 620 / down / (0,11) | 797 |
| 12 | 755 | 755 | (0,17) | 756 | 7 / 7 | 760 / down / (0,18) | 2411 |
| 13 | 800 | 805 | (0,19) | — | 2 / 3 | 丢弃，未执行 | 786 |

第 8 次观察到 `(12,10)` 的 down→left，继续选 left；第 9 次在 `(9,10)` 仍选 left。第 10 次于 479 看到食物 `(6,10)`，实际在 480 就已吃到；响应在 559 才结算，蛇已向左到 `(3,10)`。562 的下一观察才能看到新食物 `(8,18)`。

第 11 次从 `(2,10)` 选 down，响应时蛇到达 `(0,10)`，620 成功转下，避免了继续向左撞墙。第 12 次在 611 观察到 left→down 后再次选择 down；等待 2411ms，蛇继续向下成功移动七格至 `(0,17)`。B 的显式 queued 说明在这一例中没有消除重复行为，但行为本身仍不能证明误解，也可能是保留既定方向。

第 13 次在 757 观察 `(0,17)` 后选择 right。760、780 分别到 `(0,18)`、`(0,19)`，800 撞墙；答案在会话 tick 800、墙钟换算约 805 结算并丢弃。观察到死亡剩 43 tick，约 717ms，记录 elapsed 为 786ms。该次右转没有执行。

## C：末六次连续决策

Session：`arcade-4ad95679-c6e8-4df3-a1b4-dd5797b6b528`。下表保留原决策序号，没有挑掉中间请求。

| # | observedTick | 蛇头 | direction → queued | 观察中的食物 | 模型选择 |
|---:|---:|---|---|---|---|
| 19 | 1038 | (12,17) | left → left | (12,8) | `up:100` |
| 20 | 1090 | (9,17) | left → up | (12,8) | `up:100` |
| 21 | 1139 | (9,15) | up → up | (12,8) | `up:100` |
| 22 | 1252 | (9,9) | up → up | (12,8) | `up:100` |
| 23 | 1319 | (9,6) | up → up | (12,8) | `up:100` |
| 24 | 1374 | (9,3) | up → up | (12,8) | `right:100` |

| # | settledTick | wall settlement tick | 结算时蛇头 | appliedTick | 成功移动 / 尝试 | 下一实际移动 tick / 方向 / 蛇头 | elapsedMs |
|---:|---:|---:|---|---:|---|---|---:|
| 19 | 1087 | 1087 | (9,17) | 1088 | 3 / 3 | 1100 / up / (9,16) | 815 |
| 20 | 1137 | 1137 | (9,15) | 1138 | 2 / 2 | 1140 / up / (9,14) | 785 |
| 21 | 1250 | 1250 | (9,9) | 1251 | 6 / 6 | 1260 / up / (9,8) | 1851 |
| 22 | 1317 | 1317 | (9,6) | 1318 | 3 / 3 | 1320 / up / (9,5) | 1093 |
| 23 | 1371 | 1371 | (9,3) | 1372 | 3 / 3 | 1380 / up / (9,2) | 863 |
| 24 | 1441 | 1442 | (9,0) | — | 3 / 4 | 丢弃，未执行 | 1130 |

第 19 次观察 `(12,17)`、食物 `(12,8)` 时选择 up，但响应前蛇仍向左走了三格至 `(9,17)`；真正向上从 1100 的 `(9,16)` 开始，已离开食物所在列。第 20 次看见 left→up 后仍选 up。第 21 次等待期间又向上移动六格，到 `(9,9)`，1260 经过食物的 y=8 行时仍在 x=9，未吃到 `(12,8)`。

第 22 次继续向上；第 23 次的观察已经是 `(9,6)`、食物 `(12,8)`，食物在右下方，却仍选择 up。该动作不是“下一格必撞”的立即错误，但此次实际路径继续远离食物。不能从此识别模型的内部解释或排除其有意绕路，只能确认这段路径没有获得食物。

第 24 次于 1374 观察 `(9,3)` 后选择 right。1380、1400、1420 分别到 `(9,2)`、`(9,1)`、`(9,0)`，1440 撞墙；答案在会话 tick 1441、墙钟换算约 1442 结算并丢弃。观察到死亡剩 66 tick，即 1100ms，记录 elapsed 为 1130ms。C 在此 seed 存活更久，但 0 食物；原规则先比食物，所以这一 seed 是 A 优于 B、B 优于 C，不能用存活时间单独宣称 C 更好。

## 全体的有限诊断汇总

同一个现有审计脚本支持逐组读取全部 75 局，因此补充以下机械指标；不新增模型调用，不改变正式成绩。独立验收 60 局与重复运行 15 局分开列出，不能把重复运行当成新增独立 seed。全体 2,001 个存储帧、921 对已接受 decision/input 以及最终状态全部吻合，没有映射或派发闸门违例。995 次请求全部有可识别的返回选择。

“观察时邻格风险”严格指：把所选方向作用于观察位置，下一格就会越界或撞入不能离开的身体。它不是所有观察错误、策略错误或延迟风险的检测。“末次死亡后丢弃”严格指：末次决策 observedTick 小于死亡 tick、settledTick 不小于死亡 tick、结算状态已 finished、outcome 为 dropped。它说明答案未能执行，不单独证明网络延迟是唯一死因。

| 组别 | 局数 | 返回选择数 | 观察时邻格风险 | queued≠direction 次数 | 其中重复 queued | 末次死亡后丢弃 |
|---|---:|---:|---:|---:|---:|---:|
| 独立验收 A | 20 | 271 | 0 / 271 | 110 | 110 | 20 / 20 |
| 独立验收 B | 20 | 298 | 0 / 298 | 127 | 127 | 19 / 20 |
| 独立验收 C | 20 | 257 | 0 / 257 | 75 | 74 | 19 / 20 |
| 重复运行 A | 5 | 80 | 0 / 80 | 35 | 35 | 5 / 5 |
| 重复运行 B | 5 | 43 | 0 / 43 | 15 | 15 | 5 / 5 |
| 重复运行 C | 5 | 46 | 0 / 46 | 13 | 13 | 5 / 5 |

独立验收末次死亡后丢弃为 58/60（96.7%），重复运行为 15/15；合计 73/75（97.3%）。全体 995 次选择中，这个狭义的观察时邻格风险为 0；不能写成“模型没有观察错误”。375 次观察中 queued 与 direction 不同，其中 374 次选择了 queued；重复选择可能是有意保持方向，本审计没有模型内部理解的证据。三个 Harness 版本都存在这种模式，不能从比例直接推出 B/C 是否理解了文字。

总计 74 次 dropped 比末次死亡后丢弃多一次。额外一例为 C 的 `arcade-98be4c78-8421-44d9-a661-1983f4fe2b3a` 第 6 次：289 观察 `(0,4)`、direction=left、queued=down，选择 up；前次 down 在 300 生效，339 结算时蛇已在 `(0,6)`、direction=down，仍存活。up 此时已成为禁止的反向，足以被当前合法候选校验拒绝，没有 appliedTick；341 的下一观察继续正常决策，选择 right。事件没有逐项拒绝原因码，因此这里依据重建状态与现有候选规则识别拒绝条件，而非声称读到了上游错误原因。这不是自动避险或替换动作。

## 证据、复现和边界

证据来自本项目的 `artifacts/snake-experiment/jev-formal-plan.report.json` 及本项目本地 Durable Object 历史；没有读取参考项目数据库或凭证。Python 读取器只向内存重放传递明确游戏字段，TypeScript 审计器只输出有限位置、tick、动作与计数。没有导出完整身体序列、私有回放、请求、思考、Key 或认证信息。

三局的派生诊断保存于 `artifacts/snake-experiment/acceptance-first-seed-trace/audit.json`。全体分组结果保存于 `artifacts/snake-experiment/acceptance-audit-{acceptance|repeat}-{A|B|C}/audit.json`；额外丢弃例为 `artifacts/snake-experiment/acceptance-additional-drop-trace/audit.json`。这些都是忽略的本地诊断文件，不进入正式评分 ledger；其中 `eligibleForExperimentScoring:false` 表示派生输出不成为新实验样本，不改变原正式 session 的合格标记。

在有这些本地历史的原项目目录运行：

```sh
python3 scripts/audit-snake-history.py \
  --output-dir artifacts/snake-experiment/acceptance-first-seed-trace \
  --session-id arcade-b5791815-a0e6-40c2-a8dc-9ba959a6cf2b \
  --session-id arcade-dac04f02-7824-4ead-8123-ffdf1d86cbbc \
  --session-id arcade-4ad95679-c6e8-4df3-a1b4-dd5797b6b528
```

全体分组的选择逻辑仅按原报告的 partition 与 variant；每组不超过脚本的 50 个 ID 上限：

```python
import json, subprocess
from pathlib import Path
report = json.loads(Path("artifacts/snake-experiment/jev-formal-plan.report.json").read_text())
for partition in ("acceptance", "repeat"):
    for variant in "ABC":
        ids = [e["sessionId"] for e in report["entries"]
               if e["partition"] == partition and e["variant"] == variant]
        command = ["python3", "scripts/audit-snake-history.py", "--output-dir",
                   f"artifacts/snake-experiment/acceptance-audit-{partition}-{variant}"]
        for session_id in ids:
            command += ["--session-id", session_id]
        subprocess.run(command, check=True)
```

本轮引擎 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `packages/games/src/arcade/snake.ts` | `224bea22e5812735ac2c660e85260cfca320e4059b0e80f88257b3f6a6f00cae` |
| `packages/games/src/arcade/common.ts` | `887e8d7628c59d5ec026bab4bae4cb82525e2b60741d80532299a193e265c1fe` |

相关实现：[snake 规则](../../../packages/games/src/arcade/snake.ts)、[runner 的 launch/settleDecision](../../../apps/runner/src/arcade.ts)、[输入后派发闸门](../../../apps/runner/src/arcade-scheduling.ts)、[只读读取器](../../../scripts/audit-snake-history.py)、[逐 tick 重建器](../../../scripts/audit-snake-history.ts)。新 clone 没有本地历史时脚本会明确停止，不拉取其他项目数据。

本页是验收后的机制解释，不作为新的验证集、统计检验或调参理由。第一 seed 的三局不能代替 20 个独立 seed 的配对报告；下一格检测为零、queued 重复比例、末次迟到比例也不能推出单一模型认知原因。没有独立 HTTP arrival 计时，因此不把 settledTick 写成网络到达时间，不把全部死亡归因于网络延迟。
