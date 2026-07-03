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

const GITHUB_REPO_URL = "https://github.com/Davy-Chendy/Anime-Master-Game-v2";
const FEEDBACK_QQ_GROUP_URL = "https://qm.qq.com/q/bHJQIRplmg";
const OTHER_GAME_URL = "https://decrypto.monight.dpdns.org/";

type HomeFooterIcon = "video" | "rules" | "github" | "group" | "spark";

type HomeFooterLinkItemProps = {
  label: string;
  href: string | null;
  icon: HomeFooterIcon;
  wide?: boolean;
};

function HomeFooterLinkItem({ label, href, icon, wide = false }: HomeFooterLinkItemProps) {
  const iconNode =
    icon === "video" ? (
      <svg aria-hidden="true" className="home-footer-icon" viewBox="0 0 24 24">
        <rect height="12" rx="2.5" width="15" x="3" y="6" />
        <path d="M18 10.2 22 8v8l-4-2.2" />
      </svg>
    ) : icon === "rules" ? (
      <svg aria-hidden="true" className="home-footer-icon" viewBox="0 0 24 24">
        <path d="M7 4.5h8.5A2.5 2.5 0 0 1 18 7v12H8.5A2.5 2.5 0 0 0 6 21.5V7A2.5 2.5 0 0 1 8.5 4.5Z" />
        <path d="M6 7.5h9" />
        <path d="M9 11h6" />
        <path d="M9 14.5h6" />
      </svg>
    ) : icon === "github" ? (
      <svg aria-hidden="true" className="home-footer-icon" viewBox="0 0 24 24">
        <path d="M12 2.5a9.5 9.5 0 0 0-3 18.52c.48.09.65-.2.65-.47v-1.66c-2.64.57-3.2-1.12-3.2-1.12-.43-1.1-1.06-1.4-1.06-1.4-.86-.59.07-.58.07-.58.95.07 1.45.97 1.45.97.84 1.44 2.21 1.02 2.75.78.09-.61.33-1.02.6-1.26-2.1-.24-4.31-1.05-4.31-4.67 0-1.03.37-1.88.97-2.54-.1-.24-.42-1.22.09-2.54 0 0 .79-.25 2.6.97A9.02 9.02 0 0 1 12 7.8c.8 0 1.6.1 2.35.31 1.8-1.22 2.59-.97 2.59-.97.52 1.32.2 2.3.1 2.54.6.66.97 1.51.97 2.54 0 3.63-2.21 4.42-4.32 4.66.34.29.64.86.64 1.74v2.58c0 .27.17.57.66.47A9.5 9.5 0 0 0 12 2.5Z" />
      </svg>
    ) : icon === "group" ? (
      <svg aria-hidden="true" className="home-footer-icon" viewBox="0 0 24 24">
        <path d="M8 12.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
        <path d="M16.5 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
        <path d="M3.5 18.5a4.5 4.5 0 0 1 9 0" />
        <path d="M13 18.5a3.8 3.8 0 0 1 7.5 0" />
      </svg>
    ) : (
      <svg aria-hidden="true" className="home-footer-icon" viewBox="0 0 24 24">
        <path d="m12 3 1.85 5.15L19 10l-5.15 1.85L12 17l-1.85-5.15L5 10l5.15-1.85L12 3Z" />
      </svg>
    );

  const content = (
    <>
      {iconNode}
      <span>{label}</span>
    </>
  );

  if (!href) {
    return <span className={`home-footer-link home-footer-link-disabled${wide ? " home-footer-link-wide" : ""}`}>{content}</span>;
  }

  return (
    <a
      className={`home-footer-link${wide ? " home-footer-link-wide" : ""}`}
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const session = getLocalSession();
    const searchParams = new URLSearchParams(window.location.search);
    const roomCodeFromUrl = searchParams.get("roomCode") ?? "";
    const roomNotice = searchParams.get("roomNotice") ?? "";

    if (roomNotice === "kicked") {
      setNotice("你已被房主移出房间，已回到首页。");
      searchParams.delete("roomNotice");
      const nextSearch = searchParams.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`);
    }

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
    setNotice("");

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
    setNotice("");

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

      if (existingRoom.game_status === "PLAYING") {
        saveLocalSession({
          playerId: session.playerId,
          nickname: trimmedNickname,
          roomCode: trimmedRoomCode,
          isHost: existingRoom.host_player_id === session.playerId,
        });

        router.push(`/room/${existingRoom.room_code}`);
        return;
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
      <div className="grid min-h-[calc(100vh-64px)] content-center gap-6">
        <div className="grid items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <section>
            <div className="mb-6 inline-flex items-center rounded-full border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-[var(--primary)] shadow-sm">
              Anime Master Game
            </div>
            <h1 className="max-w-2xl text-4xl font-bold leading-tight text-slate-950 sm:text-5xl">
              动漫高手·一眼顶针
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-[var(--muted)]">
              和朋友一起开格子猜动画
            </p>
            <div className="mt-6">
              <QuestionGuideButton className="w-full sm:w-auto" />
            </div>
            <div className="mt-8 grid max-w-xl gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-white bg-white/70 p-4 shadow-sm">
                <p className="text-xl font-bold text-slate-950">逐格揭图</p>
                <p className="mt-1 text-xs text-[var(--muted)]">看线索猜动画名</p>
              </div>
              <div className="rounded-lg border border-white bg-white/70 p-4 shadow-sm">
                <p className="text-xl font-bold text-slate-950">14w+ 截图题库</p>
                <p className="mt-1 text-xs text-[var(--muted)]">覆盖 2k+ 部动画</p>
              </div>
              <div className="rounded-lg border border-white bg-white/70 p-4 shadow-sm">
                <p className="text-xl font-bold text-slate-950">题库社区</p>
                <p className="mt-1 text-xs text-[var(--muted)]">好题发布复用</p>
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
                  setNotice("");
                }}
              />

              <Button className="w-full" type="button" onClick={handleCreateRoom} disabled={isSubmitting}>
                {isSubmitting ? "处理中…" : "创建房间"}
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
                    setNotice("");
                  }}
                />
                <Button
                  className="mt-4 w-full"
                  type="button"
                  variant="secondary"
                  onClick={handleJoinRoom}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "处理中…" : "加入房间"}
                </Button>
              </div>

              {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
              {notice ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">{notice}</p> : null}
            </div>
          </Panel>
        </div>

        <footer className="home-footer" aria-label="相关信息">
          <div className="home-footer-grid">
            <HomeFooterLinkItem href={null} icon="video" label="视频介绍（待补）" />
            <HomeFooterLinkItem href={null} icon="rules" label="文字规则（待补）" />
            <HomeFooterLinkItem href={GITHUB_REPO_URL} icon="github" label="Github 仓库" />
            <HomeFooterLinkItem href={FEEDBACK_QQ_GROUP_URL} icon="group" label="交流反馈Q群" />
            <HomeFooterLinkItem href={OTHER_GAME_URL} icon="spark" label="作者其他动漫高手游戏：截码战" wide />
          </div>
        </footer>
      </div>
    </AppShell>
  );
}
