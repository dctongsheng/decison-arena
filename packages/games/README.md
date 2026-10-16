# Games / 规则适配器

本包的适配层、军棋和五子棋为独立 TypeScript 实现，使用项目 MIT 许可。
中国象棋使用单独保留 BSD-2-Clause 许可的 `lengyanyu258/xiangqi.js`；没有复制原 Python 三个演示项目的源码、界面、提示词或布阵方案。

`getGame('army' | 'xiangqi' | 'gomoku')` 返回 core 的 `GameAdapter`。
`create(config, seed)` 返回 JSON 可序列化状态；`apply` 不修改输入；`restore` 重演动作并核对状态。
调用方必须校验用户对席位/对局的权限。本包只校验游戏规则，不处理用户、租户或密钥。

| 游戏 | seat 0 / seat 1 | config | 动作 |
|---|---|---|---|
| 军棋 | 蓝（上方先手）/红 | 无 | `swap:from:to`、`ready`、`move:from:to` |
| 中国象棋 | 红（下方先手）/黑 | 无 | ICCS，例如 `h2h9`；Action 同时提供 from/to 格子索引 |
| 五子棋 | 黑（先手）/白 | `size: 9 \| 15`，默认15 | `place:index` |

所有格子索引从左上角开始，逐行排列；不能把旧演示的五子棋左下角坐标直接导入本包。
`GameView` 只有渲染信息；五子棋获胜连线可由 `gomokuWinningLine(state)` 获取，军棋地形来自 `armyTerrain`。

## 暗棋边界

军棋初始为自动合法布阵、`phase=setup`、`ready=[false,false]`。
任何一方均可在未准备时交换自己的棋子，交换后仍须满足旗在大本营、雷在后两排、炸弹不在前线、行营留空；双 ready 后蓝方开始。
AI 的 ready 应由运行器执行，无需调用模型。布阵动作不增加 ply，运行器命令版本仍应增加。

初始棋子 ID 仅包含起始位置，不能从 ID 推断棋种；种子仅用于重现布阵，必须留在私有状态中直到终局发布。
`observe(state, seat)` 只含该方可知局面。`view(state, seat)` 显示己方棋种与获得的敌情；`view(state,'spectator')` 显示双方共同已知情报；终局默认明棋。
所有移动动作 label 只含坐标，避免事件流暴露隐藏身份。
`view(state,'full')` 是**内部能力**，允许运行器生成私有回放帧；运行中 API/WS/社区不得返回 full 帧。任何公开接口不得接受用户指定 full 视角。

## 规则版本

- `freestyle-1`：9或15路自由五子棋；五子以上均胜，无禁手、无提子、无交换开局；满盘且无人获胜为和棋。
- `army-hidden-1`：25子双人暗棋，蓝先。大吃小，同级同毁；夺旗优先结束；否则炸弹与任何碰撞目标同毁，包含地雷；工兵排雷存活，其他军阶子碰雷阵亡而雷留存。行营内不能被攻击；任意棋子进入大本营永久不能再走；铁路普通子直行、工兵转弯、均不越子；中央仅A/C/E列连通。司令阵亡亮旗；进入敌方非旗大本营可以推断另一营的旗。无合法动作判负，相同完整局面和行棋方第三次出现判和。
- `xiangqi-casual-1-f9019ac`：将死和困毙均为轮到的一方负；三次重复、120半回合无吃子、双方仅剩将帅士象判和。不实施赛事长将/长捉责任裁定，不接受任意残局 FEN。与旧 Python 演示的四次重复、简化长将规则不同。

运行器设置的最大手数、主动结束和模型错误属于对局控制，不伪装为本包规则的自然终局。棋局外部终止结果应记录在运行器中，而不篡改规则状态，否则 restore 会拒绝不一致的状态。

## 象棋依赖来源与已知限制

- Source: https://github.com/lengyanyu258/xiangqi.js
- Commit: `f9019ac2303d4b80ef0b82fd0515bfb55a80a62b` (`0.5.2-dev`)
- Retrieved: 2026-10-15
- `src/vendor/xiangqi.cjs` 是该 commit 的 `xiangqi.js` 原文，仅改扩展名便于打包。
- `src/vendor/LICENSE.xiangqi` 保留原版权与 BSD-2-Clause 条件；`xiangqi.d.cts` 为本项目新增的窄类型声明。

上游内置 perft 在深度3返回79446；经公开 moves/move/undo 重演得到正确基准79666。本包不用内置perft。
上游 `moves({opponent:true,legal:false})` 会改变轮转，本包不开放此组合；FEN格式验证不等于合法局面验证，故仅从标准开局重放已验证动作。
回放不得只存末态 FEN，否则丢失重复局面判断所需历史。
