# Proposal: Add Spectator Visibility Controls

**Change ID:** `add-spectator-visibility-controls`  
**Created:** 2026-08-11  
**Status:** Implementation Complete  
**Completed:** 2026-08-11

## Problem Statement

观战者当前可以在答题期间查看完整原图、正确答案和玩家回答正文，可能通过正常观战界面提前获得答案并转告玩家。

## Proposed Solution

- 在房间高级设置中增加“允许提前看题”和“允许查看玩家回答”两个独立开关。
- Room Durable Object 权威决定观战连接能否收到回答正文，并在恢复快照中应用相同权限。
- 关闭提前看题时，观战者要等到本题复盘才能看到完整原图和正确答案。
- 关闭玩家回答时，复盘前仍显示提交进度，但不显示正文；复盘后补发正文。

## Scope

### In Scope

- 房间设置持久化、D1 与 Room DO 只追加迁移。
- 大厅双开关、原图/正确答案/回答正文权限。
- 实时定向投递、重连恢复和复盘补发。
- 规则、额度文档和多人回归测试。

### Out of Scope

- 防止玩家通过开发者工具读取已加载的图片资源。
- 改变团队投票、计分、阶段或结算规则。
- 新增 HTTP 轮询、Alarm 或独立观战同步接口。

## Impact Analysis

| Component | Change Required | Details |
| --- | --- | --- |
| Database | Yes | `rooms` 增加两个布尔设置；D1/DO 各自只追加 migration |
| API | Yes | 扩展现有 `updateRoomGameSettings` 参数 |
| State | Yes | Room DO 按连接角色和阶段裁剪答案正文 |
| UI | Yes | 大厅开关和观战界面权限分支 |

## Success Criteria

- [x] 两个开关可以独立组合，默认保持当前观战行为。
- [x] 关闭提前看题后，复盘前无法通过正常 UI 查看原图和正确答案。
- [x] 关闭玩家回答后，复盘前实时消息和恢复快照不向观战者提供正文。
- [x] 复盘后观战者正常看到题目和玩家回答。
- [x] 不新增轮询、D1 热路径查询、Alarm 或逐玩家 snapshot 构建。

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| 重连快照泄露正文 | Medium | High | 统一缓存权威快照，发送前按连接投影 |
| 复盘时观战数据不完整 | Medium | Medium | 复用现有 label delta 和 answer backfill |
| 多观战者导致重复构建 | Low | Medium | 一次序列化并复用接收者集合 |
| schema 升级失败 | Low | High | 事务迁移、列校验、失败不推进版本 |
