# Proposal: Add Free Rectangle Reveal

**Change ID:** `add-free-rectangle-reveal`  
**Created:** 2026-08-23  
**Status:** Implemented

## Problem Statement

个人模式当前只能按固定格子揭露图片，出题人无法精确控制提示区域。旧格子玩法应继续作为默认值，同时提供一个可选、简单且适合鼠标和触屏的自由矩形揭露方式。

## Proposed Solution

- 在大厅高级设置中增加默认关闭的“自由框选”。
- 开局时把个人揭露方式冻结到游戏会话；团队模式始终使用格子。
- 出题人每轮在本地编辑最多 16 个矩形，确认时由 Room DO 原子追加、开始倒计时并广播。
- 历史区域永久锁定并使用统一边框；当前草稿可移动、八方向缩放和删除。
- 玩家画面、重连快照和 V 键预览复用同一套归一化矩形遮罩语义。

## Scope

### In Scope

- 大厅设置、D1 只追加 migration、游戏会话冻结和最终投影。
- 三种个人模式的自由矩形揭露、重连恢复和完整复盘。
- 鼠标、触屏、键盘删除及 V 键预览。
- 几何、协议、多人、恢复、migration 和额度回归测试。

### Out of Scope

- 替换默认格子玩法。
- 修改团队对抗的格子、禁选或投票规则。
- 修改答题、计分、判定、倒计时、切轮、复盘或结算规则。
- 套索、画笔、橡皮擦、旋转矩形或编辑已提交区域。

## Impact Analysis

| Component | Change Required | Details |
| --- | --- | --- |
| Database | Yes | `rooms` 增加大厅揭露方式，`game_sessions` 增加版本化矩形揭露状态 |
| API | Yes | 扩展房间设置和开局参数，新增 `confirmRevealRegions` mutation |
| State | Yes | Room DO 权威追加已提交矩形并维护完整揭露状态 |
| UI | Yes | 大厅开关、自由框选编辑器、矩形玩家遮罩和预览 |

## Architecture Considerations

- 编辑过程仅保存在出题人客户端，每轮只发送一次确认 mutation。
- Room DO 继续单点协调阶段、deadline、checkpoint 和广播。
- 游戏热路径保持 D1 零写入；最终投影仍更新同一游戏行。
- `revealedBlocks` 继续服务格子和团队模式，旧会话缺少新状态时按格子模式恢复。

## Success Criteria

- [x] 新旧房间默认仍使用格子揭露。
- [x] 开启自由框选后三种个人模式可按每轮最多 16 个矩形完成整局。
- [x] 历史矩形不可编辑，重连后仍正确恢复；当前草稿不广播。
- [x] 团队模式和格子个人模式行为不变。
- [x] 不新增轮询、逐玩家查询、D1 热路径写入或额外 Alarm。

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| 浮点误差导致遮罩错位或全图判断错误 | Medium | High | 归一化、量化并复用同一纯几何工具 |
| 重复或旧轮确认重复追加矩形 | Medium | High | actionId/clientSeq 幂等和题号校验 |
| 最大矩形状态增大快照 | Medium | Medium | 每轮 16、每题最多 160，并增加字节预算断言 |
| 旧会话恢复失败 | Low | High | 缺少新字段时按 `GRID` 归一化，增加升级与重启测试 |
