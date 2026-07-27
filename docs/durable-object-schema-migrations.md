# Durable Object Schema 迁移与 Alarm 安全

本文记录 2026-07-27 Room Durable Object（DO）SQLite schema 事故，并规定后续迁移、Alarm 重试和代码审查要求。

## 事故摘要

Room DO 权威状态上线后，一个后续版本新增了 `mutation_journal_validation` 表，但没有提升 schema 版本。已经初始化为 v5 的 DO 因版本判断提前返回，未创建新表；恢复流程查询该表时报 `no such table: mutation_journal_validation`。过期 Alarm 和投影任务的快速重试进一步放大了写入，最终快速消耗了账号共享的 DO SQLite 日额度。

这不是“DO 权威状态”架构本身的问题，而是一次缺少版本迁移的 schema 发布，加上永久错误没有熔断所造成的事故。

## 时间线

- 2026-07-27 08:59:11，提交 `d89fc2c`：迁移 Room DO 权威状态，已有 DO 初始化为 schema v5。
- 2026-07-27 12:29:48，提交 `7ed3ff3`：增加批量答案判定、恢复逻辑和 `mutation_journal_validation` 表。
- 2026-07-27 12:31:19，对应的 production Worker v76 部署；旧 v5 DO 开始在恢复路径触发缺表错误。
- 异常 DO 约产生 `127.17k rows_written`（约占 namespace 当日写入的 88%）和 `5.08k Alarm`。
- 2026-07-27 14:22:47，production Worker v81 完成热修复部署。
- 2026-07-27 14:25:55，提交 `5308df6`：schema 提升至 v6，为旧 v5 DO 补建缺表，并保证 Alarm 下次触发至少延迟 1 秒。

## 根本原因

新增表后，初始化逻辑仍保留以下版本门槛：

```ts
if (Number(current?.version ?? 0) >= 5) return;
```

全新 DO 会执行更新后的全量建表语句，因此开发和首次初始化测试可以通过；生产中的 DO 已记录为 v5，会直接返回，永远不会创建新表。随后恢复逻辑依赖这张表，导致永久性 schema 错误。

事故有两个相互放大的原因：

1. schema 变化没有对应的新 migration/version，生产旧状态没有升级路径。
2. Alarm 把永久错误当成临时错误重试，过期任务又能快速重新调度，形成高频失败循环。

## 为什么多轮代码审查仍可能漏掉

- 审查关注了业务流程和并发一致性，但没有把新增 SQL 对象与 schema 版本变化逐项核对。
- 测试主要覆盖空数据库初始化，没有从真实生产 v5 fixture 升级。
- 全量建表语句同时承担“新建”和“升级”的表象，容易让人误以为新增表已经兼容旧实例。
- Alarm 重试逻辑没有区分临时错误与永久 schema 错误，也缺少次数上限和熔断。
- 缺少发布前的容量推演：单个异常 DO 的重试频率乘以每次写入量，足以消耗 namespace 共享额度。

## 正确迁移模式

每次 schema 变化都必须提升版本。migration 只能追加，已发布版本不能修改。以下为概念示例，具体 SQL 应与项目实现保持一致：

```ts
const LATEST_SCHEMA_VERSION = 6;

const MIGRATIONS: Record<number, string[]> = {
  // 1 到 5 保留各自已经发布的迁移，不得改写。
  6: [
    "CREATE TABLE IF NOT EXISTS mutation_journal_validation (...)"
  ]
};

for (let version = currentVersion + 1; version <= LATEST_SCHEMA_VERSION; version++) {
  // 在事务中执行 MIGRATIONS[version]，全部成功后再写入该版本号。
}
```

必须满足以下不变量：

- 从任一仍在生产中的旧版本，都能逐版本升级到最新版。
- migration 可重复执行，或通过事务与版本号保证不会留下半完成状态。
- schema 版本只能在对应 SQL 全部成功后更新。
- 初始化结束后校验关键表、列和索引；发现不一致时停止业务恢复，并输出可定位的错误。
- 新实例初始化和旧实例升级最终得到等价的 schema。

## 必须覆盖的升级测试

凡修改 DO SQLite schema，至少补充并运行以下测试：

1. 空数据库初始化到最新版。
2. 使用真实或等价的生产前一版本 fixture（本次为 v5）升级到最新版。
3. 旧版本中存在未完成 mutation journal 时，升级后可以恢复。
4. 重复初始化或重复调用迁移保持幂等。
5. 模拟迁移中途失败，确认版本号未提前推进，下一次仍可安全恢复。
6. 旧 DO 存在待处理 Alarm/projection 时，升级后不会进入循环重试。

不能用“删除本地数据库后运行成功”代替升级测试；这只证明全新初始化路径可用。

## Alarm 重试与熔断

Alarm 处理必须先分类错误：

- 临时错误（例如短暂网络或服务异常）可以重试，但必须有最小延迟、指数退避和最大次数。
- 永久错误（例如 `no such table`、`no such column`、不兼容数据）不得无限重试；应在少量尝试后熔断并记录告警，等待修复或人工处理。
- 不得把过去时间或“立即”时间直接传给 `setAlarm()`；下一次执行必须有明确的最小延迟。
- 重试计数和下一次时间应可观测。一个 DO 的异常不能无限消耗整个账号的共享额度。
- 对有写入的 Alarm，发布前应估算：`异常 DO 数 × 每分钟重试次数 × 每次 rows_written × 故障持续分钟数`。

## 代码审查清单

涉及 DO schema、journal、恢复流程或 Alarm 时，审查者必须逐项确认：

- [ ] 是否新增或修改了表、列、索引？若是，schema 版本是否同步提升？
- [ ] 是否只追加 migration，没有改写已经发布的历史 migration？
- [ ] 是否存在因 `currentVersion >= N` 提前返回而跳过新 SQL 的路径？
- [ ] 是否实际测试了“当前生产版本 -> 最新版本”，而不只是空库？
- [ ] schema 版本是否仅在事务成功后推进？关键对象是否有初始化后校验？
- [ ] journal、恢复和 Alarm 是否会在旧 schema、半迁移状态下被触发？
- [ ] 永久错误是否会停止重试并告警？临时错误是否有退避、上限和熔断？
- [ ] 是否估算了异常循环的 Alarm 次数、SQL 行读写和共享额度影响？
- [ ] 是否完成 `npm run worker:typecheck`、`npm run lint` 和 `npm run build`，并运行相关升级测试？

## 发布与回滚注意事项

- 发布 schema 变更前，确认代码对迁移中的旧实例兼容；必要时采用“先扩展 schema、再启用读写、最后清理旧结构”的分阶段发布。
- 回滚应用代码不会自动回滚 DO SQLite schema。回滚方案必须明确新旧代码能否同时读取已经迁移的数据。
- 部署后优先观察按 DO 分组的 Alarm、异常和 rows read/written；出现单个实例陡增时应尽快熔断，而不是等待共享额度耗尽。
