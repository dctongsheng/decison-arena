# Snake 实时 Harness 对照实验

2026-10-17，本地实现及真实对照已完成。**本次没有实测提升：B、C 均未达到事先固定的发布门槛，默认保留 A。** 正式成绩仅来自 Arena 已有 Jev 配置，不能推广为 StartLux 结论。参考项目未修改、未启动实验，未使用其凭证或数据库。

## 真实结果

使用既有 OpenRouter 配置，请求 `typesafe/jev-1.13`，全部响应实际模型为 `typesafe/jev-1.13-20260917`。20×20、3 格/s、120 秒、60Hz、计分、候选、持续运动及请求预算机制均不变；模型等待期间蛇继续前进。每局自然结束后才开始下一局，A/B/C 按预先顺序交错。

| 分组 | 每版本局数 | A 平均食物 | B 平均食物 | C 平均食物 | 总请求数 |
|---|---:|---:|---:|---:|---:|
| 开发预实验 | 1 | 0 | 0 | 1 | 28 |
| 独立验收 | 20 | **0.80** | 0.45 | 0.25 | 826 |
| 预先指定重复组 | 5 | 0.60 | 1.00 | 0.40 | 169 |

预实验 C 的单局领先没有在独立验收中复现；未据此改候选或挑种子。正式 75 局全部有效，995 次请求，小于事先固定的 4,000 次硬预算；另有 28 次 Jev 预实验与 1 次失败的 StartLux 认证请求，总请求尝试 1,024 次。75 局全部撞墙，没有撞身体、满盘或时间耗尽。

| 独立验收对比 | 配对食物均差 | 97.5% 配对 bootstrap 区间 | 原规则胜/平/负 | 发布门槛 |
|---|---:|---|---|---|
| B−A | −0.35 | [−0.80, +0.05] | 6 / 2 / 12 | 未通过 |
| C−A | −0.55 | [−1.00, −0.10] | 4 / 0 / 16 | 未通过 |

区间使用固定随机种子、10,000 次配对重采样，两个比较各用 97.5% 双侧区间；这是多比较的 bootstrap 近似，不是有限样本覆盖保证。B 的区间包含 0；C 在本次 Jev 实时条件下出现负向证据。都未达到预声明的至少 +0.5 食物提升，不调整门槛。

重复组 B−A 平均 +0.4、C−A −0.2，不与独立样本混算。按同一版本“重复−原始”计，A 食物波动范围 −2..0，B 0..+1，C 0；但 C 生存时间仍有 −1080..+1100 tick 的波动。B 的重复子集表现与全部独立验收方向不同，说明少量重复或单局高分不足以替代完整配对。每个种子和重复结果全部见 [完整成绩表](results.md)。同种子路径变化会改变后续食物生成位置，不能称为完全相同食物序列。

## 主要发现与因果边界

1. **已有观测确实进入请求。** runner 的 provider 出站构造测试验证原坐标、棋盘、head/tail/body、direction/queued 与 nextMoveInTicks 进入 state；A/B 仅 instructions 不同。无需重复添加这些字段。测试证明 Arena 构造，不证明上游模型利用了每个字段。
2. **实时延迟及过时观察有直接轨迹证据。** 历史 StartLux 最后一次观察距撞墙 583ms，左转回答耗时 713ms，死亡后丢弃；Jev 有在观察位置安全、接收时已经贴墙的连续决策。具体 session、观察/结算/应用 tick 和实际位移见 [历史轨迹分析](trace-audit.md)；本次固定首个验收种子的三局另见 [验收后失败窗口](acceptance-trace.md)。
3. **未发现执行代打或回放偏差。** 正式 995 条响应中 921 条接受、74 条丢弃，2,001 个存储帧与 921 对接受动作重放一致；0 请求错误、0 未知结果、0 无效回放。73 次丢弃是死亡后结算；另外一次 C 选择的方向在等待期间变成当前方向的反向，仍运行时被合法性校验拒绝，没有自动换方向。按键接受 tick 不等于下一格已转向。
4. **更长策略与状态重排没有带来提升。** 独立组延迟中位/P95：A 903/1460ms，B 891/1466.65ms，C 877/1358ms；C 延迟略低但分数更差。返回的 input_tokens 平均 A/B/C 为 2520.13/2883.43/2832.07；C 删除棋盘并加入几何后并未小于 A。各版本轨迹长度不同，这些平均数是实际调用描述，不能作为严格的输入长度因果对照。不能把状态表达、策略判断、模型输出波动和网络波动完全拆开，本轮未随机化延迟，也未把暂停诊断混入成绩。
5. **空转仍存在。** 独立组完整状态循环 A/B/C 为 2/5/7 次，单局最长无得分成功移动为 120/104/76 格。B 平均存活从 A 的 13.55s 增至 15.53s，却吃得更少；保留原先食物优先的评分，没有以生存时间替换目标。

正式全部响应的延迟中位/P95 为 898/1559.6ms；观察到接受输入中位 55 tick、3 次成功移动，P95 为 91 tick、5 次移动。服务商未返回 thoughtUsed：995 条均记“未返回”，不写成 false。Arena 继续强制实时模型关闭思考；这是请求策略与服务遥测的区别。

## StartLux 的限制

原预实验第一次真实 StartLux SystemOne 请求返回 HTTP401，整批按规则停止，无有效决策，**不计成 0 分**。会话 `arcade-4eef72dc-1e41-42f5-8a4e-d769f722eea7`：observedTick=3，失败结算 tick=59，无 appliedTick。浏览器已有 BambooNode 授权也显示过期/撤销。

在任何 Jev 请求前单独记录 [凭证可用性修订](auth-amendment.md)，沿用原开发/验收种子、候选和门槛检查另一组已有配置；随后在验收前依据 28 次预实验调用量固定 [正式预算](formal-budget.md)。没有换 Key 重试未知请求，未使用参考项目密钥；本轮不能交付 StartLux 的独立性能结论。

## A/B/C 实现、版本与回滚

- A `snake-harness-a-v1`：逐字冻结当前 v4 prompt，原观察与候选；有文本及代表性观察/候选 SHA256 回归测试。
- B `snake-harness-b-v1`：只改变策略文字，强调实时延迟、queued 已提交、100ms 不等于一格、尾格增长和以食物为目标避免空循环。
- C `snake-harness-c-v1`：沿用 B 指令，仅重新表达当前可见信息；移除重复字符棋盘，保留有序身体，给所有合法候选相同的静态几何字段，并记录前后观察变化。无未来信息、路径搜索、候选过滤或本地选方向。

新局通过 `config.snakeHarnessVersion` 选择版本。普通创建页仍默认 A；每局固定版本，暂停/恢复不会切换。回滚只需**下一局**指定 A；旧事件不重标，运行中的 B/C 不被改变，不删解析器或历史。详见 [设计与后续最小 GEPA 接口](design.md)。本轮未安装 GEPA。

## 可复现运行

先 `pnpm dev`，保持本地 5091。使用已登录、拥有已有模型的私有会话文件；本地实际使用 `artifacts/local-fixture.json`。脚本只读取其中 cookie，不输出、不提交凭证，不创建新账号。自定义现有文件用 `--auth-file`。

```sh
# 只读配置预检，不调用模型
node scripts/snake-harness-experiment.mjs inspect --out artifacts/snake-experiment/models.json

# 历史只读审计：仅本项目 DO，实际 engine 重建，不调用模型
python3 scripts/audit-snake-history.py

# 已完成实验离线重算，不重复调用
node scripts/snake-harness-experiment.mjs report --plan artifacts/snake-experiment/jev-formal-plan.json

# 导出安全报告；输出新路径，拒绝覆盖已有文件
node scripts/render-snake-experiment-report.mjs \
  --report artifacts/snake-experiment/jev-formal-plan.report.json \
  --pilot artifacts/snake-experiment/jev-pilot-plan.report.json \
  --out artifacts/snake-experiment/report-copy \
  --blocked-provider systemone --blocked-http-status 401
```

新复现实验模板（`PROFILE_JEV` 是 inspect 返回的本人已有配置 ID，不是 Key）：

```sh
# 同一 development 种子，A/B/C 预实验：最多 900 次
node scripts/snake-harness-experiment.mjs plan \
  --metadata artifacts/snake-experiment/models.json --profile-ids PROFILE_JEV \
  --seed-file docs/experiments/snake-harness-v1/seeds.json \
  --global-max-requests 900 --out artifacts/snake-experiment/reproduction-pilot.json
node scripts/snake-harness-experiment.mjs run \
  --plan artifacts/snake-experiment/reproduction-pilot.json --pilot --confirm-live

# 完成预实验并事先固定预算后，复现同一正式设计（真实调用会使用用户额度）
node scripts/snake-harness-experiment.mjs plan \
  --metadata artifacts/snake-experiment/models.json --profile-ids PROFILE_JEV \
  --seed-file docs/experiments/snake-harness-v1/seeds.json --development-seeds none \
  --global-max-requests 4000 --out artifacts/snake-experiment/reproduction-formal.json
node scripts/snake-harness-experiment.mjs run \
  --plan artifacts/snake-experiment/reproduction-formal.json --partition acceptance --confirm-live
node scripts/snake-harness-experiment.mjs run \
  --plan artifacts/snake-experiment/reproduction-formal.json --partition repeat --confirm-live
```

以上是**复现同一实验**，不能把已公开的 seeds 再当作新候选的独立留出集。后续优化须另命名版本、另建未使用种子。不要新建账本绕过未知在途请求；暂停、错误或恢复不明时停止，原账本保留。每场预留 300 次，未用额度自然结束后释放；不自动重试、不以 0 分代替异常。不要在实时实验期间运行重构建，250ms 基础设施停顿的暂停机制保持原样。

## 检查与交付证据

实验开始前在冻结源码上：`pnpm test` **442 通过**；`pnpm test:runner` **102 通过**；`pnpm typecheck`、`pnpm build`、`pnpm build:cloudflare` 通过。实验结束后，driver + 新增离线 renderer 合计 **26 项测试通过**。全部真实对局从现有本地站点的认证 API 发起；无生产部署、无社区自动发布。

```sh
pnpm test
node --test scripts/snake-harness-experiment.test.mjs scripts/render-snake-experiment-report.test.mjs
pnpm test:runner
pnpm typecheck
pnpm build
pnpm build:cloudflare
```

可分享文件：

- [完整成绩、逐种子表、重复波动和门槛](results.md)
- [结构化白名单统计](results.json)；[每局逐调用时序与动作证据](results.events.json)
- [源码/计划 hash、预算和检查清单](validation.json)
- [预声明](preregistration.md)、[种子清单](seeds.json)、[历史轨迹分析](trace-audit.md)、[验收后失败窗口](acceptance-trace.md)

原完整私有回放仍由现有 Arena 存储管理，报告不复制原始请求、思考、凭证或私有接口地址。实验账本在 gitignore 的 `artifacts/snake-experiment/`，源码和模型元数据每局核对；已有额度提示相关未提交工作保留。
