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

## 房间实时聊天预算（2026-08-10）

聊天复用每名成员已有的 Room DO WebSocket。每条聊天只有发送者产生 1 条入站 WebSocket 消息，并在同一次 DO 事件内向同 topic 的连接广播一次有界 payload；不会因为房间有 50 人而产生 50 条入站请求。按 Free 方案入站 WebSocket 消息 20:1 折算 DO 请求，出站消息不计 DO 请求，但 50 人房间的一条消息仍会产生最多 50 次网络投递并消耗少量 CPU/Duration。单条正文限制 200 个 Unicode 字符、1,024 bytes，完整入站 envelope 限制 2,048 bytes；每 socket 限制为 5 秒最多 3 条，避免正常连点造成无界突发。

服务端不保存历史，不创建聊天表，不写 D1 或 DO SQLite，不设置 Alarm，不 checkpoint，也不进入游戏 mutation 队列。浏览器只在当前标签页的 `sessionStorage` 保存最近 100 条，因此刷新不产生补拉请求，断线重连也不补发旧消息。聊天不会改变 `scripts/authority-write-budget.mjs` 的 DO/D1 行写入模型。

按 50 人、每天 60 局估算：

| 每人每局聊天量 | 每局入站消息 | 每日入站消息 | DO 请求折算 | D1 / DO SQLite 写入 |
| ---: | ---: | ---: | ---: | ---: |
| 5 条 | 250 | 15,000 | 约 750（0.75%） | 0 |
| 20 条 | 1,000 | 60,000 | 约 3,000（3%） | 0 |
| 每题 1 条（30 条） | 1,500 | 90,000 | 约 4,500（4.5%） | 0 |

上表未重复计算既有 WebSocket 建连；聊天不会新增独立连接。最重一行同时意味着每天最多约 450 万次出站客户端投递（90,000×50，实际随在线人数下降），它不占 DO 请求额度，但若生产 CPU/Duration 或网络指标明显上升，应先收紧单 socket 速率或消息长度，而不是增加存储、轮询或历史补拉。

## 答对玩家查看实时回答预算（2026-08-10）

个人模式继续使用每次提交和判定已有的 Room DO WebSocket mutation。公开积分、行动进度和判定增量仍向全房发送且不包含答案正文；完整答案复用已有观战定向增量，接收者扩展为观战者与本题已经答对的玩家。答对瞬间的已有答案按有界 delta 分块，并与该玩家已有的私有判定消息合并，不新增 HTTP/RPC、客户端 snapshot 补拉、Alarm、checkpoint、D1 或 DO SQLite 读写。改判错误和切题只根据当前权威 `questionResults` 收回接收资格，不产生清理写入。

50人极端房间有1名出题人和49名答题玩家。如果每题49人最终都答对且都需要取得49份短答案正文，理论上限为每题2,401份、30题72,030份答案正文客户端副本；每天60局为4,321,800份。它们是现有连接上的出站投递，不折算为新的 DO 入站请求，但会消耗序列化、CPU/Duration和网络处理。实现必须对同一实时答案只序列化一次并复用接收者集合，backfill 单个 delta 最多携带2条答案，禁止逐玩家查询、构建完整 snapshot 或触发补拉。`test:authority-vnext` 继续断言50人×30题下单个 delta 小于1KiB，并把 backfill 字节计入报告；本功能不改变 DO/D1 写入模型，因此 `scripts/authority-write-budget.mjs` 无需调整。

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

## 公开房间目录预算（2026-08-09）

公开房间页只在首次进入、玩家点击“刷新房间”或显式点击“加载更多”时读取，不轮询。每次读取产生 1 次 Worker 请求和 1 次 D1 查询，按游戏中、等待开始、准备题目、在大厅、本局结算的顺序读取一批最多 21 个候选；“等待开始”直接由既有 `prepared_question_source` 非空判断，不增加查询。20 个候选用于本页，额外 1 个只用于判断是否还有下一页。游标分页不使用 offset；状态、人数、游戏模式和题目来源排序只重排客户端已经取得的房间，不增加请求。这里有意不为活动时间新建索引，避免每次公开房间聚合更新都维护索引；公开房间闲置 48 小时后仍由现有清理任务删除。

所有状态超过 1 小时没有有效活跃后不展示。在大厅、准备题目和等待开始通过 D1 `public_activity_at` 提前过滤；D1 状态为 `PLAYING` 或 `GAME_RESULT` 的本页候选各产生 1 次小型只读 Room DO 请求，最多 20 次、并发 5 个、单次超时 800ms、不重试，再使用最近权威阶段推进时间做最终过滤。该 DO 响应只含状态、人数、阶段推进时间、当前题号和总题数，不进入 mutation 队列，不设置 Alarm、不 checkpoint、不广播、不构建完整 snapshot，也不写 D1/DO SQLite；单个房间失败时回退到 D1 近似人数和公开活动时间，若回退时间也已超过 1 小时则隐藏。普通玩家加入、退出、重连、身份/队伍变化和持久化 checkpoint 不刷新活动时间。过滤后不在同一次请求中自动补拉下一批，避免一次点击放大为多轮 D1/DO 请求。

大厅的 `public_activity_at` 和 `spectator_count` 合并进既有房间行更新；游戏阶段推进时间合并进既有 DO aggregate checkpoint，游戏结束时的观战人数合并进既有最终投影，不新增 SQL 语句、checkpoint 或 changed row。游戏中的加入继续只修改 Room DO 权威状态，目录 presence 从同一个 aggregate 计算成员总数和观战人数，不新增请求、存储读取或写入。50 人同时各打开第一页的最坏上限为 50 次 Worker、最多 1,000 个房间摘要和 1,000 次只读 DO 调用，不产生写入或广播惊群；实际 DO 调用数等于这 20 个候选中的游戏中/结算中房间数乘以 50。按每天 60 局、每局 50 人都各打开一次且每页 20 个候选均需 DO 读取的极端假设，为 3,000 次 Worker（3%）和 60,000 次 DO 请求（60%）。每名玩家再点击一次“加载更多”会在同一极端假设下再增加相同额度，因此它必须保持显式操作且不得自动触发；若真实 Analytics 接近该值，应优先缩小后续页大小或增加短时边缘缓存，而不是增加目录轮询或写入型目录 DO。

按每天 60 局且公开房间都保留至 48 小时清理上限估算，没有活动索引时单次目录读取仍可能扫描约 120 个公开房间；3,000 次第一页读取最多约 360,000 行 D1 读取，占每日 5,000,000 行额度的 7.2%。每次“加载更多”会增加一次同量级但仍有界的查询。这是以显式读取换取零新增索引写入；若生产公开房间数、分页深度或目录读取量明显超过该估算，应先依据 Analytics 决定是否增加短时缓存或活动时间索引。

本功能不改变单局 mutation、checkpoint、Alarm、D1 最终投影语句数、索引写入或题目图片链路，因此无需修改 `scripts/authority-write-budget.mjs`。`0021_public_room_activity.sql` 和 `0022_public_room_spectator_count.sql` 只在部署时为现有公开房间各回填一行，均不建立索引；运行时仍只修改既有房间行或既有 DO aggregate 行。

## 房间信息编辑预算（2026-08-10）

房间信息是房主在大厅或题库准备阶段显式保存的低频房间 mutation。正常路径复用已有 Room DO WebSocket，每次点击保存产生 1 条入站 WebSocket 消息、读取 1 行 D1 房间状态；内容真实变化时再更新同一行 `rooms`、更新 1 行 DO runtime version，并向房间广播 1 个只含 `roomId`、最多 80 字正文和 `updatedAt` 的小 delta。连接尚未建立时的 HTTP 路径最多产生 1 次 Worker 请求和 1 次 Room DO 请求，行为和写入上限相同。完全相同的内容直接返回，不更新 D1/DO SQLite，也不广播；不设置 Alarm、不 checkpoint、不查询玩家表、不进入游戏 action journal。

50 人在线时仍只有房主的一次入站操作，最多增加 50 次出站 WebSocket 投递，不会形成 50 次补拉。按每局编辑 2 次、每天 60 局的偏高估算，每日最多新增 120 条入站消息（按 20:1 约 6 次 DO 请求）、120 行 D1 读取、120 行 D1 数据更新和 120 行 DO SQLite version 更新，分别不超过对应 100,000 行日写入额度的 0.12%；不随每局 30 题放大。断线重连只通过既有完整房间恢复读取当前信息，不自动重放保存；D1 临时失败只向房主返回错误并等待人工重试，schema 永久错误不自动重试。`room_notice` 不建索引，migration 只为既有房间增加一个 NULL 列，因此无需修改 `scripts/authority-write-budget.mjs` 的实时游戏基线。

## 不可接受的额度模式

- 每个答案、判定、积分变化或 UI tick 写 D1/DO SQLite。
- 为保活、checkpoint 或每个 mutation 设置 Alarm。
- 客户端心跳、定期 HTTP 轮询或全员同时补拉 snapshot。
- 每个动作追加 journal、marker、processed action 或全量 normalized 投影。
- 每个动作构建、查询或广播完整 snapshot。
- 对 schema 永久错误、过期 Alarm 或投影失败无上限快速重试。
- 对每名玩家分别查询或写入可一次聚合处理的数据。
- 未测量就增加图片变体、重复转换、重复 R2 写入或无缓存读取。

## 结算前发布题库状态同步预算（2026-08-08）

最后一题进入结算前，Room DO 读取一次本局题库的最新 D1 元数据，并把公开状态合并进已有 authority vNext 聚合；随后复用既有 `game-end` checkpoint 和结算快照广播。该同步不新增 Worker/DO 入站请求、Alarm、广播、D1 写入或 DO SQLite checkpoint，只新增一次服务端 D1 读取。Manifest V2 题库读取1行题集记录；旧题库最坏再读取30行题目，因此每局最多31行。

按 50 人 × 30 题计算仍是每局一次，不随玩家数或题数逐操作放大；每天60局最多新增1,860行 D1 读取，占每日5,000,000行硬额度约0.0372%。D1 临时失败会让本次权威结算操作失败并由现有客户端重试/Outbox恢复，不会启动轮询或全员补拉；重复操作受 actionId/clientSeq 幂等保护，成功结算后不再重复读取。该改动不改变 checkpoint、最终投影或写入计量模型，因此无需调整 `scripts/authority-write-budget.mjs`。

## R2 图片上传与容量清理

- 正常上传只允许产生 1 次 Workers 请求和 1 次 R2 `PutObject`，不得为了计算 bucket 总容量在上传前后执行 `ListObjects`。
- 不在上传热路径维护或强制 10GB 总容量上限。接近容量上限时应通过生产监控识别，并清理过期房间、孤儿私有题库和不再引用的 R2 对象。
- 浏览器压缩后的最终图片不得超过 10MB；客户端先行拒绝，Worker 仍必须按实际请求体独立校验，不能信任 `Content-Length` 或客户端结果。
- Worker 对无长度或伪造长度的请求采用有界流式读取，超过 10MB 时停止读取并返回 413；合法图片才计算校验和并写入 R2。
- 远程 URL 导入允许最多 20MB 原图进入服务端压缩，写入 R2 的最终对象仍不得超过 10MB。
- 图片选择列表只读取展示所需的一页，不附带 bucket 总字节数；容量统计属于低频观测任务，不进入用户请求路径。

每日 Cron 的房间/题集清理会先汇总确认无引用的关联图片，并按每批最多 1,000 个 key 调用 R2 批量删除；不再为每张图片各产生一次 Worker 内部 R2 请求。该阶段同样遵守每轮最多 10,000 个对象的安全阀：批次失败或超过安全阀而延后的 key 所属题集本轮继续保留，等待下次幂等重试，其他成功批次可以正常收敛。房间/题集阶段和后续全 bucket 对账分别捕获并记录失败，前一阶段失败不再直接跳过后一阶段。

随后执行一次 R2 对账：读取当前 D1 图片引用，分页列出 `question-images/`，只删除无引用且已上传超过 72 小时的对象。R2 单次 `delete(keys[])` 仍严格限制为 1,000 个 key；单轮对账安全上限提高为 10,000 个对象，并拆成最多 10 次串行批量删除，超出部分由下一次每日 Cron 继续处理。按 2026-08-09 窗口末的 7,228 个 R2 对象和每页 1,000 个的请求上限估算，约需 8 次 `ListObjects` 和最多 8 次批量删除调用；R2 可能为控制内存返回少于请求上限的对象，因此实际列表次数应以生产日志为准。8 次列表操作约为 R2 每月 100 万次 Class A 免费额度的每日 0.0008%，D1 图片引用读取最坏按 7,228 行估算约占每日 500 万行额度的 0.145%。该任务由单个服务端 Cron 协调，不随同房间 50 人在线或单局题数乘以玩家数放大。

按每局新建一套 30 张图片、每天 60 局的极端上限，上传产生 1,800 次 Workers 请求和 1,800 次 R2 Class A `PutObject`/天；按 30 天计算为 54,000 次 Class A，约占 100 万月额度的 5.4%。即使极端假设这些图片以后全部成为孤儿，10,000 个/日的清理能力仍约为新增量的 5.56 倍，可以追赶历史积压；实际题库复用会更低。该链路不再产生上传相关 `ListObjects` 或 upload-gate DO 请求/duration。

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
