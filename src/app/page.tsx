"use client";

import { useEffect, useState } from "react";
import { useRouter } from "@/lib/router";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/Button";
import { FormField } from "@/components/FormField";
import { Panel } from "@/components/Panel";
import { QuestionGuideButton } from "@/components/QuestionGuideButton";
import { createNewLocalPlayerSession, getLocalSession, saveLocalSession } from "@/lib/localSession";
import { createRoom, getRoomByCode, joinRoom } from "@/lib/cloudflareRooms";

export default function HomePage() {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const session = getLocalSession();
    const roomCodeFromUrl = new URLSearchParams(window.location.search).get("roomCode") ?? "";

    setNickname(session.nickname);
    setRoomCode(/^\d{6}$/.test(roomCodeFromUrl) ? roomCodeFromUrl : (session.roomCode ?? ""));
  }, []);

  function validateNickname() {
    const trimmedNickname = nickname.trim();

    if (!trimmedNickname) {
      setError("请先输入昵称");
      return null;
    }

    return trimmedNickname;
  }

  async function handleCreateRoom() {
    const trimmedNickname = validateNickname();

    if (!trimmedNickname) {
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const session = getLocalSession();
      const room = await createRoom(session.playerId, trimmedNickname);

      saveLocalSession({
        playerId: session.playerId,
        nickname: trimmedNickname,
        roomCode: room.code,
        isHost: true,
      });

      router.push(`/room/${room.code}`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "创建房间失败，请稍后重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleJoinRoom() {
    const trimmedNickname = validateNickname();
    const trimmedRoomCode = roomCode.trim();

    if (!trimmedNickname) {
      return;
    }

    if (!/^\d{6}$/.test(trimmedRoomCode)) {
      setError("请输入 6 位房间号");
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const existingRoom = await getRoomByCode(trimmedRoomCode);

      if (!existingRoom) {
        setError("房间不存在。请检查房间号是否正确");
        return;
      }

      let session = getLocalSession();
      const isSameStoredRoom = session.roomCode === trimmedRoomCode;

      if (!isSameStoredRoom && session.nickname && session.nickname !== trimmedNickname) {
        session = createNewLocalPlayerSession(trimmedNickname);
      }

      const result = await joinRoom(trimmedRoomCode, session.playerId, trimmedNickname);

      if (result.error || !result.room) {
        setError(result.error ?? "加入房间失败，请稍后重试");
        return;
      }

      const isHost = result.room.hostPlayerId === session.playerId;

      saveLocalSession({
        playerId: session.playerId,
        nickname: trimmedNickname,
        roomCode: result.room.code,
        isHost,
      });

      router.push(`/room/${result.room.code}`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "加入房间失败，请稍后重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AppShell>
      <div className="grid min-h-[calc(100vh-64px)] items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <section>
          <div className="mb-6 inline-flex items-center rounded-full border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-[var(--primary)] shadow-sm">
            Anime Master Game
          </div>
          <h1 className="max-w-2xl text-4xl font-bold leading-tight text-slate-950 sm:text-5xl">
            动漫高手·一眼顶针
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-[var(--muted)]">
            根据动画截图猜动画的多人实时小游戏。创建房间、选择出题人、上传或选择社区题库，实时揭露图片并猜出动画名称
          </p>
          <div className="mt-6">
            <QuestionGuideButton className="w-full sm:w-auto" />
          </div>
          <div className="mt-8 grid max-w-xl gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-white bg-white/70 p-4 shadow-sm">
              <p className="text-2xl font-bold text-slate-950">6 位</p>
              <p className="mt-1 text-sm text-[var(--muted)]">房间号</p>
            </div>
            <div className="rounded-lg border border-white bg-white/70 p-4 shadow-sm">
              <p className="text-2xl font-bold text-slate-950">本地</p>
              <p className="mt-1 text-sm text-[var(--muted)]">临时身份</p>
            </div>
            <div className="rounded-lg border border-white bg-white/70 p-4 shadow-sm">
              <p className="text-2xl font-bold text-slate-950">15 人</p>
              <p className="mt-1 text-sm text-[var(--muted)]">房间上限</p>
            </div>
          </div>
        </section>

        <Panel title="进入房间">
          <div className="space-y-4">
            <FormField
              label="昵称"
              maxLength={20}
              placeholder="例如：小明"
              value={nickname}
              onChange={(event) => {
                setNickname(event.target.value);
                setError("");
              }}
            />

            <Button className="w-full" type="button" onClick={handleCreateRoom} disabled={isSubmitting}>
              {isSubmitting ? "处理中..." : "创建房间"}
            </Button>

            <div className="border-t border-[var(--line)] pt-4">
              <FormField
                label="房间号"
                inputMode="numeric"
                maxLength={6}
                placeholder="输入 6 位房间号"
                value={roomCode}
                onChange={(event) => {
                  setRoomCode(event.target.value.replace(/\D/g, "").slice(0, 6));
                  setError("");
                }}
              />
              <Button
                className="mt-4 w-full"
                type="button"
                variant="secondary"
                onClick={handleJoinRoom}
                disabled={isSubmitting}
              >
                {isSubmitting ? "处理中..." : "加入房间"}
              </Button>
            </div>

            {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
