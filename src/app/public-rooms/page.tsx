"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/Button";
import { GAME_MODE_LABELS } from "@/lib/gameModeLabels";
import { getLocalSession, saveLocalSession } from "@/lib/localSession";
import { getPublicRooms } from "@/lib/publicRooms";
import {
  PUBLIC_ROOM_DEFAULT_SORT_DIRECTIONS,
  sortPublicRooms,
  type PublicRoomSortDirection,
  type PublicRoomSortKey,
} from "@/lib/publicRoomSorting";
import { useRouter } from "@/lib/router";
import type { PublicRoomSummary, RoomQuestionSource, RoomStatus } from "@/types/game";

const STATUS_LABELS: Record<RoomStatus, string> = {
  LOBBY: "在大厅",
  QUESTION_SETUP: "准备题目",
  PLAYING: "游戏中",
  GAME_RESULT: "本局结算",
};
const STATUS_CLASSES: Record<RoomStatus, string> = {
  LOBBY: "bg-slate-100 text-slate-700",
  QUESTION_SETUP: "bg-amber-50 text-amber-800",
  PLAYING: "bg-rose-50 text-rose-700",
  GAME_RESULT: "bg-violet-50 text-violet-700",
};
const SOURCE_LABELS: Record<RoomQuestionSource, string> = {
  COMMUNITY: "社区题库",
  CREATION_TOOL: "出题工具题库",
  MANUAL: "手动出题",
};

function getStatusLabel(room: PublicRoomSummary) {
  if (room.status === "QUESTION_SETUP" && room.questionSource) return "等待开始";
  return STATUS_LABELS[room.status];
}

type SortableHeaderProps = {
  column: PublicRoomSortKey;
  label: string;
  activeColumn: PublicRoomSortKey;
  direction: PublicRoomSortDirection;
  className?: string;
  onSort: (column: PublicRoomSortKey) => void;
};

function SortableHeader({ column, label, activeColumn, direction, className = "", onSort }: SortableHeaderProps) {
  const isActive = column === activeColumn;
  return (
    <th aria-sort={isActive ? (direction === "asc" ? "ascending" : "descending") : "none"} className={`px-4 py-3 text-left ${className}`} scope="col">
      <button
        className={`inline-flex items-center gap-1.5 rounded px-1 py-1 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 ${isActive ? "text-slate-950" : "text-slate-600 hover:text-slate-950"}`}
        onClick={() => onSort(column)}
        type="button"
      >
        {label}
        <span aria-hidden="true" className={`text-xs ${isActive ? "text-[var(--primary)]" : "text-slate-400"}`}>
          {isActive ? (direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

function formatRelativeActivity(value: string, now = Date.now()) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "未知";
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  return `${Math.floor(elapsedHours / 24)} 天前`;
}

export default function PublicRoomsPage() {
  const router = useRouter();
  const [rooms, setRooms] = useState<PublicRoomSummary[]>([]);
  const [currentRoomCode, setCurrentRoomCode] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<PublicRoomSortKey>("status");
  const [sortDirection, setSortDirection] = useState<PublicRoomSortDirection>("asc");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const sortedRooms = useMemo(
    () => sortPublicRooms(rooms, sortKey, sortDirection),
    [rooms, sortDirection, sortKey],
  );

  const loadRooms = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const page = await getPublicRooms();
      setRooms(page.rooms);
      setNextCursor(page.nextCursor);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "读取公开房间失败。");
    } finally {
      setIsLoading(false);
    }
  }, []);

  async function loadMoreRooms() {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    setError("");
    try {
      const page = await getPublicRooms(nextCursor);
      setRooms((currentRooms) => {
        const mergedRooms = new Map(currentRooms.map((room) => [room.id, room]));
        for (const room of page.rooms) mergedRooms.set(room.id, room);
        return [...mergedRooms.values()];
      });
      setNextCursor(page.nextCursor);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "读取更多房间失败。");
    } finally {
      setIsLoadingMore(false);
    }
  }

  useEffect(() => {
    const session = getLocalSession();
    if (!session.nickname.trim()) {
      router.push("/?publicRoomsNotice=nickname");
      return;
    }
    setCurrentRoomCode(session.roomCode);
    void loadRooms();
  }, [loadRooms]);

  function changeSort(column: PublicRoomSortKey) {
    if (sortKey === column) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(column);
    setSortDirection(PUBLIC_ROOM_DEFAULT_SORT_DIRECTIONS[column]);
  }

  function enterRoom(room: PublicRoomSummary) {
    const session = getLocalSession();
    const normalizedNickname = session.nickname.trim();
    if (!normalizedNickname) {
      router.push("/?publicRoomsNotice=nickname");
      return;
    }
    saveLocalSession({
      playerId: session.playerId,
      nickname: normalizedNickname,
      roomCode: room.code,
      isHost: session.roomCode === room.code && session.isHost,
    });
    router.push(`/room/${room.code}`);
  }

  return (
    <AppShell>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <button className="text-sm font-semibold text-[var(--primary)] hover:underline" onClick={() => router.push("/")} type="button">← 返回首页</button>
          <h1 className="mt-3 text-3xl font-bold text-slate-950 sm:text-4xl">公开房间</h1>
          <p aria-live="polite" className="mt-2 text-sm text-[var(--muted)]">
            {isLoading ? "正在读取房间" : `${nextCursor ? "已显示" : "共"} ${rooms.length} 个房间 · 仅显示近 2 小时有效活跃的房间`}
          </p>
        </div>
        <Button className="shadow-none" disabled={isLoading || isLoadingMore} onClick={() => void loadRooms()} type="button" variant="secondary">{isLoading ? "读取中…" : "刷新房间"}</Button>
      </header>

      {error ? <p className="mt-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}

      <div aria-busy={isLoading || isLoadingMore} className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[900px] border-collapse">
          <thead className="border-b border-slate-200 bg-slate-50/80">
            <tr>
              <SortableHeader activeColumn={sortKey} className="w-[20%]" column="name" direction={sortDirection} label="房间名" onSort={changeSort} />
              <SortableHeader activeColumn={sortKey} className="w-[14%]" column="status" direction={sortDirection} label="状态" onSort={changeSort} />
              <SortableHeader activeColumn={sortKey} className="w-[20%]" column="mode" direction={sortDirection} label="游戏模式" onSort={changeSort} />
              <SortableHeader activeColumn={sortKey} className="w-[9%] text-center" column="people" direction={sortDirection} label="人数" onSort={changeSort} />
              <SortableHeader activeColumn={sortKey} className="w-[16%]" column="source" direction={sortDirection} label="题目来源" onSort={changeSort} />
              <SortableHeader activeColumn={sortKey} className="w-[13%]" column="activity" direction={sortDirection} label="最近活跃" onSort={changeSort} />
              <th className="w-[8%] px-4 py-3 text-right text-sm font-semibold text-slate-600" scope="col">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading ? [0, 1, 2].map((item) => (
              <tr className="animate-pulse" key={item}>
                <td className="px-4 py-5" colSpan={7}><div className="h-5 rounded bg-slate-100" /></td>
              </tr>
            )) : rooms.length === 0 ? (
              <tr>
                <td className="px-6 py-12 text-center" colSpan={7}>
                  <p className="text-lg font-bold text-slate-900">暂无公开房间</p>
                  <p className="mt-2 text-sm text-[var(--muted)]">{nextCursor ? "可以继续加载更多房间。" : "稍后刷新，或返回首页创建房间。"}</p>
                </td>
              </tr>
            ) : sortedRooms.map((room) => {
              const isCurrentRoom = currentRoomCode === room.code;
              const isDefinitelyFull = room.memberCount >= room.capacity && !room.isMemberCountApproximate && !isCurrentRoom;
              return (
                <tr className="transition hover:bg-slate-50/70" key={room.id}>
                  <td className="max-w-48 px-4 py-4"><p className="truncate font-bold text-slate-950" title={room.name}>{room.name}</p></td>
                  <td className="px-4 py-4">
                    <div className="flex flex-col items-start gap-1">
                      <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CLASSES[room.status]}`}>{getStatusLabel(room)}</span>
                      {room.status === "PLAYING" &&
                      Number.isInteger(room.currentQuestionIndex) &&
                      Number.isInteger(room.questionCount) &&
                      Number(room.currentQuestionIndex) >= 0 &&
                      Number(room.questionCount) > Number(room.currentQuestionIndex) ? (
                        <span className="whitespace-nowrap text-xs font-medium text-slate-500">第 {Number(room.currentQuestionIndex) + 1} / {room.questionCount} 题</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-sm font-semibold text-slate-800">{GAME_MODE_LABELS[room.gameMode]}</td>
                  <td className="whitespace-nowrap px-4 py-4 text-center text-sm font-semibold text-slate-800">
                    {room.isMemberCountApproximate ? "约 " : ""}{room.memberCount}/{room.capacity}
                    {room.spectatorCount > 0 ? <span className="mt-0.5 block text-xs font-medium text-slate-500">（观战：{room.spectatorCount}）</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-sm font-semibold text-slate-800">{room.questionSource ? SOURCE_LABELS[room.questionSource] : "暂未准备"}</td>
                  <td className="whitespace-nowrap px-4 py-4 text-sm text-slate-700">{formatRelativeActivity(room.updatedAt)}</td>
                  <td className="px-4 py-4 text-right">
                    <button
                      className="h-10 whitespace-nowrap rounded-md bg-[var(--primary)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--primary-strong)] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isDefinitelyFull}
                      onClick={() => enterRoom(room)}
                      type="button"
                    >
                      {isCurrentRoom ? "返回房间" : isDefinitelyFull ? "房间已满" : "加入"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Button disabled={isLoading || isLoadingMore} onClick={() => void loadMoreRooms()} type="button" variant="secondary">
            {isLoadingMore ? "加载中…" : "加载更多"}
          </Button>
        </div>
      ) : null}
    </AppShell>
  );
}
