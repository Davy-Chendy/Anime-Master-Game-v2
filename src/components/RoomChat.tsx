"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { sendRoomChatMessage, subscribeRoomChat } from "@/lib/cloudflareClient";
import {
  appendRoomChatMessage,
  loadRoomChatMessages,
  saveRoomChatMessages,
  type StoredRoomChatMessage,
} from "@/lib/roomChat";
import { ROOM_CHAT_MAX_TEXT_CODE_POINTS } from "@/types/chat";
import type { Player } from "@/types/game";

export type RoomChatDisplayMode = "closed" | "compact" | "expanded";

const ROOM_CHAT_PANEL_HEIGHT_STORAGE_KEY = "anime-master:room-chat-panel-height";
const ROOM_CHAT_PANEL_MIN_HEIGHT = 92;
const ROOM_CHAT_PANEL_DEFAULT_HEIGHT = 240;

export function clampRoomChatPanelHeight(height: number, viewportHeight = 800) {
  const maximum = Math.max(ROOM_CHAT_PANEL_MIN_HEIGHT, Math.floor(viewportHeight * 0.5));
  return Math.max(ROOM_CHAT_PANEL_MIN_HEIGHT, Math.min(maximum, Math.round(height)));
}

function loadPanelHeight() {
  if (typeof window === "undefined") return ROOM_CHAT_PANEL_DEFAULT_HEIGHT;
  try {
    const raw = window.localStorage.getItem(ROOM_CHAT_PANEL_HEIGHT_STORAGE_KEY);
    const stored = raw == null ? Number.NaN : Number(raw);
    return Number.isFinite(stored)
      ? clampRoomChatPanelHeight(stored, window.innerHeight)
      : clampRoomChatPanelHeight(ROOM_CHAT_PANEL_DEFAULT_HEIGHT, window.innerHeight);
  } catch {
    return ROOM_CHAT_PANEL_DEFAULT_HEIGHT;
  }
}

function savePanelHeight(height: number) {
  try {
    window.localStorage.setItem(ROOM_CHAT_PANEL_HEIGHT_STORAGE_KEY, String(height));
  } catch {
    // The current component state remains usable when localStorage is unavailable.
  }
}

export type RoomChatController = {
  messages: StoredRoomChatMessage[];
  mode: RoomChatDisplayMode;
  unreadCount: number;
  panelHeight: number;
  error: string;
  send: (text: string) => Promise<void>;
  setMode: (mode: RoomChatDisplayMode) => void;
  setPanelHeight: (height: number) => void;
  commitPanelHeight: (height: number) => void;
  reportError: (message: string) => void;
};

export function useRoomChat(options: {
  roomId?: string | null;
  playerId: string;
  players: readonly Player[];
}): RoomChatController {
  const { roomId, playerId, players } = options;
  const [messages, setMessages] = useState<StoredRoomChatMessage[]>([]);
  const [mode, setDisplayMode] = useState<RoomChatDisplayMode>("compact");
  const [unreadCount, setUnreadCount] = useState(0);
  const [panelHeight, setPanelHeightState] = useState(loadPanelHeight);
  const [error, setError] = useState("");
  const playersRef = useRef(players);
  const modeRef = useRef(mode);
  playersRef.current = players;
  modeRef.current = mode;

  useEffect(() => {
    setMessages(roomId ? loadRoomChatMessages(roomId) : []);
    setUnreadCount(0);
    setError("");
  }, [roomId]);

  useEffect(() => {
    if (!roomId || !playerId) return;
    const topic = `room:${roomId}`;
    return subscribeRoomChat(topic, (event) => {
      if (event.type === "chat_error") {
        setError(event.message);
        return;
      }
      if (event.topic !== topic) return;
      const nickname = playersRef.current.find((player) => player.id === event.playerId)?.nickname ?? "已离开玩家";
      const stored: StoredRoomChatMessage = { ...event, nickname };
      setMessages((current) => {
        const next = appendRoomChatMessage(current, stored);
        saveRoomChatMessages(roomId, next);
        return next;
      });
      if (modeRef.current === "closed") setUnreadCount((count) => Math.min(99, count + 1));
    }, { playerId });
  }, [playerId, roomId]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(""), 4000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const setMode = useCallback((nextMode: RoomChatDisplayMode) => {
    setDisplayMode(nextMode);
    if (nextMode !== "closed") setUnreadCount(0);
  }, []);

  const send = useCallback(async (text: string) => {
    if (!roomId) throw new Error("聊天房间尚未就绪。");
    setError("");
    await sendRoomChatMessage(`room:${roomId}`, text);
  }, [roomId]);

  const setPanelHeight = useCallback((height: number) => {
    const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
    setPanelHeightState(clampRoomChatPanelHeight(height, viewportHeight));
  }, []);

  const commitPanelHeight = useCallback((height: number) => {
    const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
    const next = clampRoomChatPanelHeight(height, viewportHeight);
    setPanelHeightState(next);
    savePanelHeight(next);
  }, []);

  return {
    messages,
    mode,
    unreadCount,
    panelHeight,
    error,
    send,
    setMode,
    setPanelHeight,
    commitPanelHeight,
    reportError: setError,
  };
}

function formatMessageTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp);
}

export function RoomChatBar({
  controller,
  playerId,
  compactMessageCount = 2,
}: {
  controller: RoomChatController;
  playerId: string;
  compactMessageCount?: 1 | 2;
}) {
  const [text, setText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const recentMessages = controller.messages.slice(-compactMessageCount);
  const isExpanded = controller.mode === "expanded";

  const scrollToBottom = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    setIsNearBottom(true);
  }, []);

  useEffect(() => {
    if (controller.mode !== "expanded" || !isNearBottom) return;
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [controller.messages.length, controller.mode, isNearBottom, scrollToBottom]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isSending || !text.trim()) return;
    setIsSending(true);
    try {
      await controller.send(text);
      setText("");
    } catch (caughtError) {
      controller.reportError(caughtError instanceof Error ? caughtError.message : "聊天消息发送失败。");
    } finally {
      setIsSending(false);
    }
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startY = event.clientY;
    const startHeight = controller.panelHeight;
    let latestHeight = startHeight;
    const handleMove = (moveEvent: PointerEvent) => {
      latestHeight = startHeight + startY - moveEvent.clientY;
      controller.setPanelHeight(latestHeight);
    };
    const finish = () => {
      controller.commitPanelHeight(latestHeight);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = finish;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home") return;
    event.preventDefault();
    const step = event.shiftKey ? 48 : 16;
    const next = event.key === "Home"
      ? ROOM_CHAT_PANEL_DEFAULT_HEIGHT
      : controller.panelHeight + (event.key === "ArrowUp" ? step : -step);
    controller.commitPanelHeight(next);
  }

  return (
    <div className="relative w-full">
      {controller.mode === "expanded" ? (
        <section
          aria-label="房间聊天记录"
          className="absolute bottom-16 left-0 z-30 flex w-[calc(100%_-_4rem)] flex-col overflow-hidden rounded-lg border border-slate-200/80 bg-[oklch(0.985_0.002_250_/_0.96)] shadow-[0_12px_36px_rgba(23,32,51,0.12)] sm:bottom-0 sm:w-[calc(57.5%_-_4.25rem)]"
          style={{ height: controller.panelHeight }}
        >
          <div
            aria-label="调整聊天面板高度"
            aria-orientation="horizontal"
            className="group grid h-3 shrink-0 cursor-ns-resize place-items-center touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rose-200"
            role="separator"
            tabIndex={0}
            onDoubleClick={() => controller.commitPanelHeight(ROOM_CHAT_PANEL_DEFAULT_HEIGHT)}
            onKeyDown={handleResizeKeyDown}
            onPointerDown={beginResize}
          >
            <span className="h-1 w-10 rounded-full bg-slate-300 transition group-hover:bg-slate-400" />
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto py-1"
            ref={listRef}
            onScroll={(event) => {
              const target = event.currentTarget;
              setIsNearBottom(target.scrollHeight - target.scrollTop - target.clientHeight < 32);
            }}
          >
            {controller.messages.length > 0 ? controller.messages.map((message) => (
              <div className="flex min-w-0 items-baseline gap-2 px-3 py-1.5 text-base leading-6 transition hover:bg-[oklch(0.955_0.003_250_/_0.72)]" key={message.messageId} title={`${message.nickname}：${message.text}`}>
                <span className={`max-w-28 shrink-0 truncate font-semibold ${message.playerId === playerId ? "text-rose-700" : "text-slate-700"}`}>{message.nickname}：</span>
                <span className="min-w-0 flex-1 truncate text-slate-950">{message.text}</span>
                <time className="shrink-0 text-sm tabular-nums text-[var(--muted)]">{formatMessageTime(message.sentAt)}</time>
              </div>
            )) : (
              <p className="grid h-full min-h-16 place-items-center text-base text-[var(--muted)]">还没有聊天消息</p>
            )}
          </div>
          {!isNearBottom ? (
            <button className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--line)] bg-white px-3 py-1.5 text-sm font-semibold shadow-md" type="button" onClick={scrollToBottom}>查看新消息</button>
          ) : null}
        </section>
      ) : null}

      <div className={controller.mode === "closed" ? "grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)]" : "grid gap-2 sm:grid-cols-[minmax(320px,1.15fr)_minmax(240px,0.85fr)]"}>
        {controller.mode === "closed" ? (
          <button
            className="flex h-14 items-center justify-center gap-2 rounded-lg border border-[var(--line)] bg-white px-4 text-base font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-rose-100"
            type="button"
            onClick={() => controller.setMode("compact")}
          >
            显示记录
            {controller.unreadCount > 0 ? <span className="grid min-w-6 place-items-center rounded-full bg-rose-100 px-1.5 py-0.5 text-xs font-bold text-rose-700">{controller.unreadCount === 99 ? "99+" : controller.unreadCount}</span> : null}
          </button>
        ) : isExpanded ? (
          <div className="pointer-events-none relative z-40 flex h-14 min-w-0 items-center justify-end">
            <button
              className="pointer-events-auto h-10 rounded-md border border-slate-200/80 bg-[oklch(0.985_0.002_250_/_0.96)] px-2.5 text-base font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200"
              type="button"
              onClick={() => controller.setMode("compact")}
            >
              收起
            </button>
          </div>
        ) : (
          <div className="flex h-14 min-w-0 overflow-hidden rounded-lg border border-[var(--line)] bg-slate-50/70 transition hover:border-slate-300 focus-within:ring-4 focus-within:ring-rose-100">
            <button aria-label="展开聊天记录" className="flex min-w-0 flex-1 items-stretch text-left focus-visible:outline-none" type="button" onClick={() => controller.setMode("expanded")}>
              {recentMessages.length > 0 ? recentMessages.map((message, index) => (
                <span className={`flex min-w-0 flex-1 items-center px-3 text-base text-slate-700 ${index > 0 ? "border-l border-[var(--line)]" : ""}`} key={message.messageId}>
                  <span className="truncate"><span className="font-semibold">{message.nickname}：</span>{message.text}</span>
                </span>
              )) : <span className="flex min-w-0 flex-1 items-center px-3 text-base text-[var(--muted)]">还没有聊天消息</span>}
            </button>
            <div className="flex shrink-0 items-center gap-1 border-l border-[var(--line)] bg-white px-1.5">
              <button className="h-10 rounded-md px-2.5 text-base font-semibold text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200" type="button" onClick={() => controller.setMode("expanded")}>展开</button>
              <button className="h-10 rounded-md px-2.5 text-base font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200" type="button" onClick={() => controller.setMode("closed")}>隐藏</button>
            </div>
          </div>
        )}

        <form className="flex h-14 min-w-0 items-center rounded-lg border border-[var(--line)] bg-white p-1 transition focus-within:border-[var(--primary)] focus-within:ring-4 focus-within:ring-rose-100" onSubmit={handleSubmit} onKeyDown={(event) => event.stopPropagation()}>
          <input
            aria-label="房间聊天内容"
            className="h-12 min-w-0 flex-1 border-0 bg-transparent px-3 text-base outline-none placeholder:text-slate-400"
            name="roomChatText"
            placeholder="输入消息"
            value={text}
            onChange={(event) => setText(Array.from(event.target.value).slice(0, ROOM_CHAT_MAX_TEXT_CODE_POINTS).join(""))}
          />
          <button
            className="h-10 shrink-0 rounded-md bg-[var(--primary)] px-4 text-base font-semibold text-white transition hover:bg-[var(--primary-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isSending || !text.trim()}
            type="submit"
          >
            {isSending ? "发送中…" : "发送"}
          </button>
        </form>
      </div>
      {controller.error ? <p className="mt-1 text-sm font-medium text-red-700">{controller.error}</p> : null}
    </div>
  );
}
