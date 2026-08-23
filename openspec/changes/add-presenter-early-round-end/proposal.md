# Proposal: Add Presenter Early Round End

**Change ID:** `add-presenter-early-round-end`  
**Created:** 2026-08-23  
**Status:** Implementation Complete  
**Completed:** 2026-08-23

## Problem Statement

个人模式中，只要仍在房间名单内的任一有效玩家没有行动，出题人就必须等待完整倒计时。玩家掉线但没有显式离房时仍属于当前有效玩家，常导致所有实际在线玩家已经完成后全房空等下一轮揭露。

## Proposed Solution

- 倒计时开放且仍有玩家未行动时，允许当前出题人点击“提前结束本轮”。
- Room DO 校验当前题号、轮次和权威 deadline，原子关闭当前轮并复用自然截止的未行动玩家自动放弃逻辑。
- 已提交和待判答案保持不变；提前结束不判定、不计分、不切轮、不公布答案。
- 当前轮快照保存提前结束时间，供全房实时提示以及刷新、重连恢复。
- 后续判定和“进入下一轮/公布答案”继续沿用现有手动流程。

## Scope

### In Scope

- `ROUND_REVEAL`、`BUZZER_FIRST_CORRECT`、`BUZZER_RANKED` 三种个人模式。
- 出题人权限、题号/轮次/deadline 校验、幂等与 Alarm 竞争。
- 自动放弃、提交锁定、快照广播、恢复提示和 UI 确认。
- 规则、额度和多人/重复/乱序/恢复回归测试。

### Out of Scope

- 在线检测、心跳、断线自动放弃或自动踢人。
- 团队对抗投票阶段。
- 自动判定、自动切轮、自动公布答案。
- 新增 HTTP 轮询、D1 热路径读写或额外 Alarm。

## Impact Analysis

| Component | Change Required | Details |
| --- | --- | --- |
| Database | No | 使用现有 active-game JSON 可选字段，不新增表、列或索引 |
| API | Yes | 新增出题人 `endRoundEarly` WebSocket mutation |
| State | Yes | Room DO 关闭当前 deadline、补自动放弃并记录当前轮提前结束时间 |
| UI | Yes | 倒计时中提供确认按钮并展示权威提前结束提示 |

## Architecture Considerations

- Room DO 继续作为 deadline 和阶段转换的唯一权威来源。
- 提前结束与玩家提交、客户端重试和 Alarm 进入同一 mutation 队列，由服务端接收顺序决定结果。
- 自然截止和提前结束共享同一个关闭当前个人轮次的内部实现，避免规则漂移。
- 关闭当前 deadline 后必须拒绝答案、放弃和取消放弃；不能只依赖原始 `roundStartedAt` 计算。
- 每次使用只增加一条出题人 WebSocket mutation 和一次现有快照广播，并取消尚未执行的原 deadline Alarm。

## Success Criteria

- [x] 出题人可以在个人模式倒计时中提前结束当前轮。
- [x] 未行动玩家恰好补一次自动放弃，已行动和已答对玩家不被覆盖。
- [x] 待判答案保留，当前题和轮次不会自动推进。
- [x] 提前结束后的玩家操作被权威拒绝，重复、旧轮和 Alarm 竞争不重复生效。
- [x] 全房和重连客户端都能看到提前结束原因。
- [x] 团队模式及自然 deadline 行为保持不变。

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| 提前结束后仍接受晚到答案 | Medium | High | 提交校验同时要求匹配的权威 deadline 仍存在 |
| 与到期 Alarm 重复补放弃 | Medium | High | Room DO 串行化、actionId/clientSeq 幂等、deadline 清除后 Alarm no-op |
| 待判答案丢失或自动切轮 | Low | High | 复用自然截止语义并增加三模式回归测试 |
| 旧 active-game 状态恢复失败 | Low | High | 新字段可选且缺失时归一化为 null，增加 checkpoint/恢复测试 |
