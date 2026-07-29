# Cloudflare Free 额度与工程预算

## 文档用途

本项目按 Cloudflare Free 方案设计。本文件记录当前官方额度、项目自己的安全预算和修改时的审查规则，避免功能正确但因请求或存储放大而无法运行。

官方额度会变化。以下数字核对于 **2026-07-28**；修改计量链路或引用具体额度前，应重新查询文末官方链接。额度通常由账号共享，不能假设每个房间、DO 或数据库各有一份。

## 当前官方 Free 额度

| 组件 | Free 额度 | 计量提醒 |
| --- | ---: | --- |
| Workers | 100,000 动态请求/天 | 每次调用最多 10ms CPU；静态资源不进入 Worker 时不计动态请求 |
| Durable Objects 请求 | 100,000/天 | 包含连接、RPC、Alarm；入站 WebSocket 消息按 20:1 折算，出站消息和协议 ping 不收费 |
| Durable Objects Duration | 13,000 GB-s/天 | Hibernation 可停止空闲 WebSocket DO 的 duration 计量 |
| DO SQLite 行读取 | 5,000,000 行/天 | 扫描行按实际读取计量 |
| DO SQLite 行写入 | 100,000 行/天 | INSERT/UPDATE/DELETE 及索引维护都可能计入 |
| DO SQLite 存储 | 5GB 总量 | 不按天重置 |
| D1 行读取 | 5,000,000 行/天 | 全表扫描和重复补拉会放大读取 |
| D1 行写入 | 100,000 行/天 | 表行和索引行均可能计入；SQL 语句数不等于 rows written |
| D1 存储 | 5GB 总量 | 不按天重置 |
| R2 Standard | 10GB-month/月 | 另含 100 万 Class A、1,000 万 Class B 操作/月；公网出口免费 |
| Cloudflare Images | 5,000 个唯一转换/月 | 同一原图的不同转换会分别占用唯一转换额度 |
| Pages | 500 次构建/月 | Free 同时 1 个构建，单次最长 20 分钟 |

R2、Images、Pages 是月额度，不应强行换算成“每日重置”。Pages Functions 和 `/api/*` 仍按 Workers 请求计量。

## 当前极端单局基线

基线场景为 50 名玩家、30 题、约 3,090 个 mutation。数字来自 `test:authority-vnext`、`test:authority-budget` 和本地 workerd 压力测试，不是 Cloudflare SLA。

| 指标 | 当前结果或目标 |
| --- | ---: |
| 游戏进行中 D1 写入 | 0 |
| DO SQLite changed rows | 实测约 272；目标 150～300 |
| D1 最终投影 | roster 未变化时约 35～69 行；硬上限 500 行 |
| rolling checkpoint | 约 241 次，普通答案和判定不单独写 SQL |
| 最大 active game | 约 324KB |
| 最大单 Attachment | 实测约 336B，硬预算 12,288B |
| 50 人 Attachment 总恢复体积 | 实测约 7KB，工程目标不超过约 100KB |
| 入站 mutation 的 DO 请求折算 | 约 `3090 / 20 = 155` 个请求，另加连接、RPC 和 Alarm |

WebSocket 建连会同时经过 Worker 和 Room DO；重连会重复产生连接请求。出站广播虽然不计 DO 请求，但仍消耗 CPU、duration 和网络处理，不能无限扩大 payload 或广播次数。

## 每天 60 局容量推演

每天 10 个房间、每房间 6 局，共 60 局。只按当前极端单局基线估算：

| 指标 | 60 局估算 | Free 日额度占比 |
| --- | ---: | ---: |
| DO SQLite changed rows | 16,320 | 16.32% |
| D1 最终投影，典型 | 2,100～4,140 | 2.10%～4.14% |
| D1 最终投影，全部触及硬上限 | 30,000 | 30% |
| mutation 的 DO 请求折算 | 约 9,270 | 9.27%，未含连接、RPC、Alarm 和重连 |

该表不是承诺容量。生产还会有创建/加入房间、恢复、题库查询、后台清理、异常重试和其他项目共享用量，因此不能把 100% 额度当作可用预算。正常设计应保留至少 50% 的账号级余量，异常路径还必须有熔断。

## 不可接受的额度模式

- 每个答案、判定、积分变化或 UI tick 写 D1/DO SQLite。
- 为保活、checkpoint 或每个 mutation 设置 Alarm。
- 客户端心跳、定期 HTTP 轮询或全员同时补拉 snapshot。
- 每个动作追加 journal、marker、processed action 或全量 normalized 投影。
- 每个动作构建、查询或广播完整 snapshot。
- 对 schema 永久错误、过期 Alarm 或投影失败无上限快速重试。
- 对每名玩家分别查询或写入可一次聚合处理的数据。
- 未测量就增加图片变体、重复转换、重复 R2 写入或无缓存读取。

## 修改时必须完成的预算检查

涉及 Worker、DO、D1、WebSocket、Alarm、R2、Images、Pages Functions 或 Cron 的改动，实施前后都要回答：

1. 一次真实用户动作会产生多少 Worker 请求、DO 请求、SQL 读写行、Alarm、R2/Images 操作和广播？
2. 50 人同时操作时是否乘以 50，还是由服务端合并为一次？
3. 50 人 × 30 题和每天 60 局分别消耗多少额度？
4. 断线重连、D1 临时失败、Alarm 重试和 schema 永久错误会放大多少倍？是否有界？
5. 新增或修改索引后，写入计量是否重新估算？
6. 是否需要更新 `scripts/authority-write-budget.mjs`、压力测试断言和本文基线？

若无法给出可验证的估算，不应把该实现放入实时热路径。

## 团队投票频繁提交的后续优化记录

团队模式按“一阶段一个服务端 deadline”实现；全员提前提交且剩余超过5秒时，允许把该 deadline 单调缩短一次并重设 Alarm。普通选格点击保留为客户端草稿，只有显式提交才发送 mutation；实时游戏阶段继续保持 D1 零写入。

以下优化暂不作为首版固定倒计时的前置条件，仅在真实单局指标显示投票 mutation、rolling checkpoint 或广播明显偏高时实施：

- 猜测投票改为先在客户端选择、再显式确认，避免点击已有答案或“不猜”时立即发送 mutation。
- 对连续修改做短时防抖或 last-write-wins 合并，并在截止前显式提交时立即发送最终值。
- 客户端忽略与上次已提交内容完全相同的重复提交；服务端把相同投票识别为 no-op，不增加 dirty action。
- 除全员首次提交完成触发的单次5秒确认期外，投票修改不得调用 `setAlarm()`，避免频繁修改造成 Alarm 反复重排和额外存储写入。

团队倒计时上线后应按单局记录并复核：投票 mutation 数、DO 请求折算、Alarm 设置/执行/重试次数、checkpoint 次数及 changed rows、最大 active game/Attachment 体积、广播次数/字节和最终 D1 写入。若一局开销明显高于预算基线，再决定是否启用上述提交合并，或增加最大团队回合数等游戏规则限制。

当前计量模型为：每题禁选只在出题人确认时产生1个 WebSocket mutation、1次小状态广播和1行 phase-boundary checkpoint，不设置独立 Alarm，也不写 D1。首个选格 Alarm 从题目建立时延后到禁选完成时设置，因此不增加投票阶段的 Alarm 总数。每个投票阶段设置并执行一个 Alarm；若全员提前提交且剩余超过5秒，该阶段先增加一次1行 active-game checkpoint，再最多额外 `setAlarm()` 一次，后续修改不再重排。deadline 阶段边界仍强制 checkpoint，游戏中 D1 写入保持0。若一道题发生 R 次选格和 G 次猜测，其中 C 次猜测以“不猜”或猜错继续游戏（`C ≤ G`），则 Alarm 执行与 deadline checkpoint 均约为 `R + G` 次，另有1次禁选和 C 次出题人回合确认 mutation/checkpoint；全员均提前完成时，Alarm 设置最多为 `2 × (R + G)`，阶段 checkpoint 最多为 `1 + 2 × (R + G) + C`。例如10次选格+10次猜测且10次都继续游戏，约20次 Alarm 执行、最多40次 Alarm 设置和51次1行 checkpoint。回合结算本身不设置 Alarm；仅出题人的 `advanceTeamBattleTurn` 产生1次小广播，50名玩家不会形成入站请求放大。玩家投票 mutation 仍可能达到“提交人数×修改次数”；每个阶段内每累计20个 dirty action 会多一次1行 rolling checkpoint，已被提前完成 checkpoint 持久化的 action 不会再次累计到 deadline。以每阶段6人各提交一次为例，不会额外触发 rolling checkpoint；频繁修改才会增加。这正是上述后续优化的观测重点。

为吸收本地运行时及平台可能出现的 Alarm 短暂触发抖动，每个团队投票阶段在 deadline 过去1秒仍未收到阶段广播时，只允许出题人客户端发送一次 `finalizeTeamBattleVote` 兜底 mutation；普通玩家不会共同触发，Room DO 仍复核出题人身份和权威 deadline。兜底成功时它替代本阶段尚未执行的 Alarm 完成同一次 phase-boundary checkpoint，并把物理 Alarm 重排到下一阶段，因此不增加 D1、阶段 checkpoint 或 Alarm 执行；最坏只增加 `R + G` 条入站 WebSocket 消息。按一题10次选格+10次猜测为20条，50人不会放大；若极端按30题均达到该回合数，则每局最多600条、每天60局36,000条，按20:1折算约1,800个 DO 请求，占日硬额度1.8%。Alarm 在1秒内正常执行时兜底不会发送。

按团队模式50人×30题估算，禁选阶段额外产生30个入站 mutation、30次小广播和30行 DO SQLite checkpoint，WebSocket 入站按20:1折算约1.5个 DO 请求；不增加 D1、图片转换或 Alarm 执行。每天60局增加1,800个入站 mutation、1,800次小广播和1,800行 DO SQLite，折算约90个 DO 请求，DO SQLite 日硬额度占比1.8%。重连只恢复已 checkpoint 的禁选结果；Outbox 重放由 actionId/clientSeq 幂等去重，不会重复应用或新增无界写入。

回合结算确认最多等于猜测阶段数量。按一题10次猜测的示例，每题最多增加10个出题人 mutation、10次小广播和10行 DO SQLite checkpoint；不增加 Alarm、D1、图片处理或客户端轮询。极端按30题都达到10次继续游戏计算，每局最多增加300个 mutation/300行，60局每天增加18,000个 mutation/18,000行；WebSocket 入站按20:1约折算900个 DO 请求/天，DO SQLite 日硬额度占比18%。该成本与50人房间人数无关，不产生全员确认或补拉风暴。

## 手动分队计量

手动分队是开局前的低频房间 mutation，不增加轮内 Alarm、图片操作或定期读取。每次真实选队产生一次 Room DO 入站操作、一次房间状态行更新和一次房间推送；客户端不轮询，也不在收到推送后补拉 snapshot。模式从手动切换为自动或切换到非团队模式时，都在既有设置 mutation 的同一次房间行更新中清空整份 JSON 映射，不逐玩家写入，因此不增加请求、广播或 changed rows。

按 50 人每局各选队一次、每天 60 局的极端上限估算，共 3,000 次 mutation 和至多 3,000 行房间状态写入，分别约占 Worker/DO 请求和 D1/DO SQLite 日硬额度的 3%（WebSocket 入站消息按平台规则折算时 DO 请求占用更低）。广播最多产生 50×50 次客户端投递，但出站 WebSocket 消息不按 DO 请求计量；实现仍复用房间推送并保持 payload 有界。游戏已经开始后的新玩家选队写入现有 active-game aggregate，随既有 checkpoint 合并，轮内 D1 写入仍为 0，最终 roster handoff 语句数不增加。

## 对应测试

- `npm run test:authority-budget`：快速检查 50×30 的 DO/D1 写入预算。
- `npm run test:authority-vnext`：检查热路径零 D1 写入、checkpoint 合并、Alarm 和 projection。
- `npm run test:authority-local-runtime`：使用 workerd、真实 WebSocket 和本地 D1 检查并发、重连、恢复及最终写入。
- 具体选测规则见 [`testing.md`](testing.md)。

## 官方来源

- Workers pricing：https://developers.cloudflare.com/workers/platform/pricing/
- Durable Objects pricing：https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects Hibernation：https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- D1 pricing：https://developers.cloudflare.com/d1/platform/pricing/
- R2 pricing：https://developers.cloudflare.com/r2/pricing/
- Images pricing：https://developers.cloudflare.com/images/pricing/
- Pages limits：https://developers.cloudflare.com/pages/platform/limits/
