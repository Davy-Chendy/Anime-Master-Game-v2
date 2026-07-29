# Proposal: Add Manual Team Assignment

**Change ID:** `add-manual-team-assignment`  
**Created:** 2026-07-29  
**Status:** Implementation Complete  
**Completed:** 2026-07-29

## Problem Statement

团队模式当前只在开局时随机分成红蓝两队，房主和玩家无法在大厅自行组队，也无法在开局前确认所有答题玩家都已入队。中途加入团队游戏的玩家也没有队伍选择入口。

## Proposed Solution

- 为房间增加自动/手动分队模式及手动队伍映射，由 Room Durable Object 权威协调。
- 手动模式允许非观战、非出题玩家在 `LOBBY` 和 `QUESTION_SETUP` 自由换队。
- 开局时服务端原子校验两队非空且所有答题玩家已入队。
- 游戏进行中加入的玩家原子选择身份和队伍，并从下一题生效。
- 通过实时房间推送同步队伍变化，snapshot 仅用于首次加载和恢复。

## Scope

### In Scope

- 大厅自动/手动分队设置、玩家选队、标记和排序。
- D1 与 Room DO schema 只追加迁移。
- 开局校验、出题人豁免、身份/离房清理。
- 游戏中手动选队加入并在下一题生效。
- 规则、额度与回归测试更新。

### Out of Scope

- 游戏开始后现有队员换队。
- 房主代替其他玩家分队。
- 强制红蓝队人数平衡。

## Impact Analysis

| Component | Change Required | Details |
| --- | --- | --- |
| Database | Yes | rooms 增加分队模式和 JSON 映射；D1/DO 各自只追加 migration |
| API | Yes | 设置模式、选队和加入参数扩展 |
| State | Yes | Room 权威状态交接至 TeamBattleState.initialTeams |
| UI | Yes | 大厅设置、队伍按钮、排序、开局阻塞原因和加入弹窗 |

## Success Criteria

- [x] 手动模式下大厅和题库准备阶段均可自由换队。
- [x] 出题人不入队且不阻塞开始；观战者不参与校验。
- [x] 红蓝队任一为空或存在未分队答题玩家时服务端拒绝开始。
- [x] 手动切换自动会清空分队，切回手动不会恢复旧值。
- [x] 游戏中手动选队加入者当前题观看、下一题进入所选队伍。
- [x] 多人、重复、乱序、重连、迁移失败和恢复测试通过。

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| 并发选队覆盖 | Medium | High | 所有 mutation 经同一个 Room DO 串行协调 |
| 开局读取过期 roster | Medium | High | 开局在 DO 内完成 handoff 后读取权威房间状态并校验 |
| 中途加入立即参与当前题 | Medium | High | 只写 initialTeams，下一题 reset 时进入 teams |
| schema 升级失败 | Low | High | v9→v10 事务 migration、列校验和失败不推进版本测试 |
