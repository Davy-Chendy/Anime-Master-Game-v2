"use client";

import type { PublicRoomSummary } from "@/types/game";

export type PublicRoomPage = {
  rooms: PublicRoomSummary[];
  nextCursor: string | null;
};

export async function getPublicRooms(cursor?: string): Promise<PublicRoomPage> {
  const apiBase = (import.meta.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
  const cursorQuery = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const response = await fetch(`${apiBase}/api/public-rooms${cursorQuery}`, {
    method: "GET",
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null) as { rooms?: PublicRoomSummary[]; nextCursor?: string | null; error?: string } | null;
  if (!response.ok) throw new Error(payload?.error || "读取公开房间失败，请稍后重试。");
  return {
    rooms: Array.isArray(payload?.rooms) ? payload.rooms : [],
    nextCursor: typeof payload?.nextCursor === "string" ? payload.nextCursor : null,
  };
}
