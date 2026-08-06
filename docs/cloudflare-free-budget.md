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

基线场景为同房间共 50 人（1 名房主/出题人 + 49 名答题玩家）、30 题、约 3,030 个 mutation。数字来自 `test:authority-vnext`、`test:authority-budget` 和本地 workerd 压力测试，不是 Cloudflare SLA。

| 指标 | 当前结果或目标 |
| --- | ---: |
| 游戏进行中 D1 写入 | 0 |
| DO SQLite changed rows | 实测约 242；目标 150～300 |
| D1 最终投影 | 4 条聚合语句；计费行预估约 5～40，硬上限 500 行 |
| checkpoint | 实测约 211 次，其中 rolling action-count 约 120 次 |
| 最大 active game | 约 324KB |
| 最大单 Attachment | 实测约 336B，硬预算 12,288B |
| 50 人 Attachment 总恢复体积 | 实测约 7KB，工程目标不超过约 100KB |
| 入站 mutation 的 DO 请求折算 | 约 `3030 / 20 = 152` 个请求，另加连接、RPC 和 Alarm |

WebSocket 建连会同时经过 Worker 和 Room DO；重连会重复产生连接请求。出站广播虽然不计 DO 请求，但仍消耗 CPU、duration 和网络处理，不能无限扩大 payload 或广播次数。

## Room runtime generation 4 与单行房间状态硬切

维护硬切后，`rooms.runtime_generation` 只有新建房间显式写入 `4`；历史 generation 3/NULL 房间在 Worker 入口返回 `ROOM_VERSION_EXPIRED`。旧 DO 若已有连接或 Alarm，会在任何恢复/业务处理前删除 Alarm、发送既有 `room_expired` 协议并关闭 socket；不会继续投影旧状态或形成 Alarm 重试环。

Generation 4 不再为新房间写 `players` 表。玩家名单以版本化、最多 50 人且最多 64KiB 的 JSON 存入现有 `rooms` 行；房主、生命周期和大厅设置继续使用同一行的标量列。创建房间只插入一行 `rooms`；加入、退出、踢人、身份和手动分队以 revision CAS 更新同一行；完全相同的重连、设置或选队直接返回，不产生 D1 UPDATE。游戏结束时，房间生命周期和完整 roster 也合并为一次 `rooms` UPDATE，不再执行 normalized player DELETE/UPSERT 或差异读取。

依据 2026-07-30 的完整生产窗口，player UPSERT 548 行、最终 roster UPSERT 391 行、player 删除/差异 30 行，合计 969 rowsWritten；房间设置/最终投影另有 325 行，二者共 1,294 行，占当日 3,795 行的 34.1%。最终 roster 差异读取另消耗 4,512 rowsRead。Generation 4 的部署后验收目标为：player 派生写入降至 150～220 行，4,512 行最终差异读取接近归零；和题集 manifest 同时代回同等业务量后，D1 日写入目标约 1,330～1,600 行。该范围来自已有生产归因与本地路径计数，索引 rowsWritten 仍必须以上线后的 Analytics 完整窗口复核。

新 `ROOM_OBJECTS_V3` namespace 的首次初始化只创建 `room_runtime_schema`、`room_runtime_meta` 和三张 `authority_vnext_*` 表。应用数据只新增 schema version 与 runtime meta 两行；SQLite catalog 的实际计费行数依赖平台实现，必须在生产部署后用 Analytics 复核，不能把本地 SQL 语句数当成 rows written。结构预算和回归测试要求为：五张表、零张 legacy 表、重复初始化零新增应用行。

`runtime_generation` 不建索引，因此房间创建不会增加额外索引写入。每次 WebSocket 握手会通过房间主键读取一次 generation；按 50 人 × 10 个房间估算为 500 行 D1 读取，占 5,000,000 日额度的 0.01%。HTTP 路由必须复用同一次房间定位结果，禁止为了 generation 重复查询。

## 每天 60 局容量推演

每天 10 个房间、每房间 6 局，共 60 局。只按当前极端单局基线估算：

| 指标 | 60 局估算 | Free 日额度占比 |
| --- | ---: | ---: |
| DO SQLite changed rows | 14,520 | 14.52% |
| D1 最终投影，典型 | 300～2,400 | 0.30%～2.40% |
| D1 最终投影，全部触及硬上限 | 30,000 | 30% |
| mutation 的 DO 请求折算 | 约 9,090 | 9.09%，未含连接、RPC、Alarm 和重连 |

该表不是承诺容量。生产还会有创建/加入房间、恢复、题库查询、后台清理、异常重试和其他项目共享用量，因此不能把 100% 额度当作可用预算。正常设计应保留至少 50% 的账号级余量，异常路径还必须有熔断。

## Question Set Manifest V2 预算（2026-07-31）

本轮预算以 [`cloudflare-usage-history/2026-07-30.md`](cloudflare-usage-history/2026-07-30.md) 的完整生产窗口为依据，不把 SQL 语句数当作计费行数。该窗口 D1 共写入 3,795 行，其中题目创建 796 行、题集创建 146 行、结算逐题标签投影 810 行，三项合计 1,752 行，占 46.2%；孤儿私有题集候选查询读取 65,062 行，占当日 D1 读取 64.9%。

新题集改为 `question_sets` 单行、最多 30 题的版本化 JSON manifest；旧题集继续读取 `questions`，不回填。新私有题集的预部署估算为约 4 rowsWritten（数据行、主键、创建者索引、私有清理 partial index），实际仍须以上线后的 D1 Analytics 为准。结算无标签变化时写 0 行；有一题或多题首次补标签时，以 revision CAS 合并为最多 1 次 manifest 行更新。旧题集也只更新真实 dirty 且原标签为空的题目。

| 场景 | 旧模型 | Manifest V2 | 估算减少 |
| --- | ---: | ---: | ---: |
| 新建 30 题题集 | `146/16 + 30 × 796/204 ≈ 126.2` 行 | 约 4 行 | 约 122.2 行（96.8%） |
| 30 题结算标签投影，无新标签 | 最多 30 行 | 0 行 | 30 行 |
| 30 题结算标签投影，存在新标签 | 最多 30 行 | 最多 1 行 CAS | 最多 29 行 |
| 每天 60 局且每局新建 30 题题集 | 约 9,372 行（创建 + 标签） | 最多约 300 行 | 约 9,072 行 |

将新模型代回 2026-07-30 的相同业务量，理论 D1 日写入约从 3,795 降至 2,120 左右；考虑题集数量口径、索引计费和失败重试的不确定性，工程验收区间设为约 2,150～2,350。D1 日读取目标为约 35,000～45,000 行，主要来自私有题集候选 partial index 与房间引用索引消除 65,062 行级扫描；这部分只能在候选规模相近的部署后完整窗口确认。

`0017_question_set_manifest.sql` 会把六个社区目录索引重建为仅覆盖公开题集的 partial index，并新增私有清理与房间引用索引。远程 migration 前必须只读统计公开/私有题集和房间数量，避开日额度紧张窗口；索引重建属于一次性写入，不得混入稳定业务日预算。回滚版本若不理解 manifest-only 行将无法读取新题集，因此部署顺序必须先让 reader/cleanup/projection 全部兼容，再让新写入路径生效。

## 不可接受的额度模式

- 每个答案、判定、积分变化或 UI tick 写 D1/DO SQLite。
- 为保活、checkpoint 或每个 mutation 设置 Alarm。
- 客户端心跳、定期 HTTP 轮询或全员同时补拉 snapshot。
- 每个动作追加 journal、marker、processed action 或全量 normalized 投影。
- 每个动作构建、查询或广播完整 snapshot。
- 对 schema 永久错误、过期 Alarm 或投影失败无上限快速重试。
- 对每名玩家分别查询或写入可一次聚合处理的数据。
- 未测量就增加图片变体、重复转换、重复 R2 写入或无缓存读取。

## R2 图片上传与容量清理

- 正常上传只允许产生 1 次 Workers 请求和 1 次 R2 `PutObject`，不得为了计算 bucket 总容量在上传前后执行 `ListObjects`。
- 不在上传热路径维护或强制 10GB 总容量上限。接近容量上限时应通过生产监控识别，并清理过期房间、孤儿私有题库和不再引用的 R2 对象。
- 浏览器压缩后的最终图片不得超过 10MB；客户端先行拒绝，Worker 仍必须按实际请求体独立校验，不能信任 `Content-Length` 或客户端结果。
- Worker 对无长度或伪造长度的请求采用有界流式读取，超过 10MB 时停止读取并返回 413；合法图片才计算校验和并写入 R2。
- 远程 URL 导入允许最多 20MB 原图进入服务端压缩，写入 R2 的最终对象仍不得超过 10MB。
- 图片选择列表只读取展示所需的一页，不附带 bucket 总字节数；容量统计属于低频观测任务，不进入用户请求路径。

每日 Cron 在原有房间/题集清理之后执行一次 R2 对账：读取当前 D1 图片引用，分页列出 `question-images/`，只批量删除无引用且已上传超过 72 小时的对象，每轮最多 1,000 个；对账失败不得反向阻断房间和题集清理。按 2026-08-03 的 5,588 个 R2 对象和 5,152 个 D1 唯一引用估算，每天约 6 次 `ListObjects`、最多 1 次批量删除和约 5,152 行 D1 读取；不会随 50 人同时在线或单局题数放大。6 次列表操作约为 R2 每月 100 万次 Class A 免费额度的每日 0.0006%，D1 引用读取约为每日 500 万行免费额度的 0.103%。

按每局新建一套 30 张图片、每天 60 局的极端上限，上传产生 1,800 次 Workers 请求和 1,800 次 R2 Class A `PutObject`/天；按 30 天计算为 54,000 次 Class A，约占 100 万月额度的 5.4%。实际题库复用会更低。该链路不再产生上传相关 `ListObjects` 或 upload-gate DO 请求/duration。

JSONL/图片链接导入先在 Worker 中抓取并写入 R2，再把已准备图片返回客户端排序、删除；玩家确认后新增 1 次 `createUploadedQuestionSet` Worker RPC，才写入最终题集。R2 写入次数与原链路一致，确认后的 D1 题集写入次数不变，放弃草稿时反而不再留下私有题集。按每天 60 局全部使用链接题库估算，最多新增 60 次 Workers 请求/天，占 100,000 次日额度的 0.06%；该操作仅由出题人触发，不随房间 50 人在线而放大。

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

当前计量模型为：出题人禁选是默认关闭的高级设置。默认路径在题目建立时直接设置首个选格 Alarm，不产生额外入站 mutation、广播或 checkpoint；开启后每题禁选只在出题人确认时产生1个 WebSocket mutation、1次小状态广播和1行 phase-boundary checkpoint，不设置独立 Alarm，也不写 D1。首个选格 Alarm 延后到禁选完成时设置，因此不增加投票阶段的 Alarm 总数。每个投票阶段设置并执行一个 Alarm；若全员提前提交且剩余超过5秒，该阶段先增加一次1行 active-game checkpoint，再最多额外 `setAlarm()` 一次，后续修改不再重排。deadline 阶段边界仍强制 checkpoint，游戏中 D1 写入保持0。若一道题发生 R 次选格和 G 次猜测，其中 C 次猜测以“不猜”或猜错继续游戏（`C ≤ G`），则 Alarm 执行与 deadline checkpoint 均约为 `R + G` 次，另有 C 次出题人回合确认 mutation/checkpoint；开启禁选时再各加1次。全员均提前完成时，Alarm 设置最多为 `2 × (R + G)`，默认阶段 checkpoint 最多为 `2 × (R + G) + C`，开启禁选时再加1。回合结算本身不设置 Alarm；仅出题人的 `advanceTeamBattleTurn` 产生1次小广播，50名玩家不会形成入站请求放大。

为吸收本地运行时及平台可能出现的 Alarm 短暂触发抖动，每个团队投票阶段在 deadline 过去1秒仍未收到阶段广播时，只允许出题人客户端发送一次 `finalizeTeamBattleVote` 兜底 mutation；普通玩家不会共同触发，Room DO 仍复核出题人身份和权威 deadline。兜底成功时它替代本阶段尚未执行的 Alarm 完成同一次 phase-boundary checkpoint，并把物理 Alarm 重排到下一阶段，因此不增加 D1、阶段 checkpoint 或 Alarm 执行；最坏只增加 `R + G` 条入站 WebSocket 消息。按一题10次选格+10次猜测为20条，50人不会放大；若极端按30题均达到该回合数，则每局最多600条、每天60局36,000条，按20:1折算约1,800个 DO 请求，占日硬额度1.8%。Alarm 在1秒内正常执行时兜底不会发送。

按团队模式50人×30题估算，默认关闭禁选时上述额外开销均为0。开启后禁选阶段额外产生30个入站 mutation、30次小广播和30行 DO SQLite checkpoint，WebSocket 入站按20:1折算约1.5个 DO 请求；不增加 D1、图片转换或 Alarm 执行。每天60局均开启时增加1,800个入站 mutation、1,800次小广播和1,800行 DO SQLite，折算约90个 DO 请求，DO SQLite 日硬额度占比1.8%。重连只恢复已 checkpoint 的禁选结果；Outbox 重放由 actionId/clientSeq 幂等去重，不会重复应用或新增无界写入。

回合结算确认最多等于猜测阶段数量。按一题10次猜测的示例，每题最多增加10个出题人 mutation、10次小广播和10行 DO SQLite checkpoint；不增加 Alarm、D1、图片处理或客户端轮询。极端按30题都达到10次继续游戏计算，每局最多增加300个 mutation/300行，60局每天增加18,000个 mutation/18,000行；WebSocket 入站按20:1约折算900个 DO 请求/天，DO SQLite 日硬额度占比18%。该成本与50人房间人数无关，不产生全员确认或补拉风暴。

## 手动分队计量

手动分队是开局前的低频房间 mutation，不增加轮内 Alarm、图片操作或定期读取。每次真实选队产生一次 Room DO 入站操作、一次房间状态行更新和一次房间推送；客户端不轮询，也不在收到推送后补拉 snapshot。模式从手动切换为自动或切换到非团队模式时，都在既有设置 mutation 的同一次房间行更新中清空整份 JSON 映射，不逐玩家写入，因此不增加请求、广播或 changed rows。

按 50 人每局各选队一次、每天 60 局的极端上限估算，共 3,000 次 mutation 和至多 3,000 行房间状态写入，分别约占 Worker/DO 请求和 D1/DO SQLite 日硬额度的 3%（WebSocket 入站消息按平台规则折算时 DO 请求占用更低）。广播最多产生 50×50 次客户端投递，但出站 WebSocket 消息不按 DO 请求计量；实现仍复用房间推送并保持 payload 有界。游戏已经开始后的新玩家选队写入现有 active-game aggregate，随既有 checkpoint 合并，轮内 D1 写入仍为 0，最终 roster handoff 语句数不增加。

## 对应测试

- `npm run test:authority-budget`：快速检查 50×30 的 DO/D1 写入预算。
- `npm run test:authority-vnext`：检查热路径零 D1 写入、checkpoint 合并、Alarm 和 projection。
- `npm run test:authority-local-runtime`：使用 workerd、真实 WebSocket 和本地 D1 检查并发、重连、恢复及最终写入。
- `npm run test:room-runtime-cutover`：检查 D1 generation/room-state migration、极简 DO schema、迁移失败不推进和旧 DO Alarm 退役。
- 具体选测规则见 [`testing.md`](testing.md)。

## 官方来源

- Workers pricing：https://developers.cloudflare.com/workers/platform/pricing/
- Durable Objects pricing：https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects Hibernation：https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- D1 pricing：https://developers.cloudflare.com/d1/platform/pricing/
- R2 pricing：https://developers.cloudflare.com/r2/pricing/
- Images pricing：https://developers.cloudflare.com/images/pricing/
- Pages limits：https://developers.cloudflare.com/pages/platform/limits/
