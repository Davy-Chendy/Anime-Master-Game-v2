import assert from "node:assert/strict";
import test from "node:test";

import { getPublicRoomsResponse, listPublicRooms, type Env } from "../worker/index";

type Status = "LOBBY" | "QUESTION_SETUP" | "PLAYING" | "GAME_RESULT";
type Row = {
  id: string;
  room_code: string;
  room_name: string;
  game_status: Status;
  lobby_game_mode: "ROUND_REVEAL";
  member_count: number;
  spectator_count: number;
  lobby_player_capacity: number;
  lobby_spectator_capacity: number;
  prepared_question_source: "MANUAL" | null;
  created_at: string;
  activity_at: string;
  updated_at: string;
  status_rank: number;
};

const NOW = Date.parse("2026-08-09T10:00:00Z");
function statusRank(status: Status, questionSource: Row["prepared_question_source"]) {
  if (status === "PLAYING") return 0;
  if (status === "QUESTION_SETUP") return questionSource ? 1 : 2;
  if (status === "LOBBY") return 3;
  return 4;
}

function room(
  id: string,
  status: Status,
  updatedAt: string,
  playerCount = 1,
  questionSource: Row["prepared_question_source"] = status === "LOBBY" ? null : "MANUAL",
  spectatorCount = 0,
): Row {
  return {
    id,
    room_code: id.replace(/\D/g, "").padStart(6, "0").slice(-6),
    room_name: id,
    game_status: status,
    lobby_game_mode: "ROUND_REVEAL",
    member_count: playerCount,
    spectator_count: spectatorCount,
    lobby_player_capacity: 50,
    lobby_spectator_capacity: 50,
    prepared_question_source: questionSource,
    created_at: updatedAt,
    activity_at: updatedAt,
    updated_at: updatedAt,
    status_rank: statusRank(status, questionSource),
  };
}

function createEnv(pages: Row[][], presence: Record<string, Response | Error>) {
  const fetchedTopics: string[] = [];
  const boundQueries: unknown[][] = [];
  let queryIndex = 0;
  const env = {
    DB: {
      prepare(sql: string) {
        assert.match(sql, /room_visibility='PUBLIC'/);
        assert.match(sql, /game_status IN \('PLAYING','GAME_RESULT'\) OR COALESCE\(public_activity_at,updated_at\)>=\?/);
        assert.match(sql, /game_status='QUESTION_SETUP' AND prepared_question_source IS NOT NULL/);
        assert.match(sql, /ORDER BY status_rank ASC, activity_at DESC, created_at DESC, id DESC/);
        assert.doesNotMatch(sql, /SELECT\s+\*/i);
        return {
          bind(...values: unknown[]) {
            boundQueries.push(values);
            return { all: async () => ({ results: pages[queryIndex++] ?? [] }) };
          },
        };
      },
    },
    ROOM_OBJECTS_V3: {
      idFromName(topic: string) { return topic; },
      get(topic: string) {
        return {
          async fetch() {
            fetchedTopics.push(topic);
            const response = presence[topic];
            if (response instanceof Error) throw response;
            return response ?? new Response(null, { status: 404 });
          },
        };
      },
    },
  } as unknown as Env;
  return { env, fetchedTopics, boundQueries };
}

function createResponseCache() {
  const entries = new Map<string, Response>();
  const matchedKeys: string[] = [];
  const writtenKeys: string[] = [];
  const cache = {
    async match(request: RequestInfo | URL) {
      const key = request instanceof Request ? request.url : String(request);
      matchedKeys.push(key);
      return entries.get(key)?.clone();
    },
    async put(request: RequestInfo | URL, response: Response) {
      const key = request instanceof Request ? request.url : String(request);
      writtenKeys.push(key);
      entries.set(key, response.clone());
    },
  } satisfies Pick<Cache, "match" | "put">;
  return { cache, entries, matchedKeys, writtenKeys };
}

test("public room directory filters every status by authoritative one-hour activity", async () => {
  const rows = [
    { ...room("playing", "PLAYING", "2026-08-09T07:00:00Z", 3), lobby_player_capacity: 10 },
    room("setup-ready", "QUESTION_SETUP", "2026-08-09T09:45:00Z", 2, "MANUAL", 1),
    room("setup-preparing", "QUESTION_SETUP", "2026-08-09T09:44:00Z", 2, null),
    room("lobby-fresh", "LOBBY", "2026-08-09T09:40:00Z"),
    room("lobby-boundary", "LOBBY", "2026-08-09T09:00:00Z"),
    room("lobby-stale", "LOBBY", "2026-08-09T08:59:59Z"),
    { ...room("lobby-membership-churn", "LOBBY", "2026-08-09T09:59:00Z"), activity_at: "2026-08-09T08:00:00Z" },
    room("result", "GAME_RESULT", "2026-08-09T08:00:00Z", 4),
  ];
  const { env, fetchedTopics, boundQueries } = createEnv([rows], {
    "room:playing": Response.json({
      status: "PLAYING",
      playerCount: 12,
      spectatorCount: 3,
      playerCapacity: 20,
      spectatorCapacity: 30,
      updatedAt: "2026-08-09T09:50:00Z",
      currentQuestionIndex: 6,
      questionCount: 30,
    }),
    "room:result": Response.json({
      status: "GAME_RESULT",
      playerCount: 6,
      spectatorCount: 2,
      updatedAt: "2026-08-09T09:55:00Z",
      currentQuestionIndex: 29,
      questionCount: 30,
    }),
  });

  const page = await listPublicRooms(env, null, NOW);
  assert.deepEqual(page.rooms.map(({ id }) => id), ["playing", "setup-ready", "setup-preparing", "lobby-fresh", "lobby-boundary", "result"]);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(fetchedTopics.sort(), ["room:playing", "room:result"]);
  assert.equal(page.rooms[0].playerCount, 12);
  assert.equal(page.rooms[0].spectatorCount, 3);
  assert.equal(page.rooms[0].playerCapacity, 20);
  assert.equal(page.rooms[0].spectatorCapacity, 30);
  assert.equal(page.rooms[0].isCountApproximate, false);
  assert.equal(page.rooms[0].updatedAt, "2026-08-09T09:50:00Z");
  assert.equal(page.rooms[0].currentQuestionIndex, 6);
  assert.equal(page.rooms[0].questionCount, 30);
  assert.equal(page.rooms.find((room) => room.id === "setup-ready")?.spectatorCount, 1);
  assert.equal(page.rooms[5].updatedAt, "2026-08-09T09:55:00Z");
  assert.equal(boundQueries[0][1], "2026-08-09T09:00:00.000Z");
  assert.equal(boundQueries[0].at(-1), 21);
});

test("public room directory falls back safely when presence is unavailable or invalid", async () => {
  const rows = [
    room("playing-error-fresh", "PLAYING", "2026-08-09T09:45:00Z", 3),
    room("playing-invalid-fresh", "PLAYING", "2026-08-09T09:40:00Z", 4),
    room("playing-error-stale", "PLAYING", "2026-08-09T08:59:59Z", 5),
  ];
  const { env } = createEnv([rows], {
    "room:playing-error-fresh": new Error("temporary failure"),
    "room:playing-invalid-fresh": Response.json({
      status: "PLAYING",
      playerCount: 8,
      updatedAt: "not-a-time",
      currentQuestionIndex: 30,
      questionCount: 30,
    }),
    "room:playing-error-stale": new Error("temporary failure"),
  });

  const page = await listPublicRooms(env, null, NOW);
  assert.deepEqual(page.rooms.map(({ id }) => id), ["playing-error-fresh", "playing-invalid-fresh"]);
  assert.equal(page.rooms[0].updatedAt, "2026-08-09T09:45:00Z");
  assert.equal(page.rooms[0].playerCount, 3);
  assert.equal(page.rooms[0].spectatorCount, 0);
  assert.equal(page.rooms[0].isCountApproximate, true);
  assert.equal(page.rooms[1].updatedAt, "2026-08-09T09:40:00Z");
  assert.equal(page.rooms[1].playerCount, 8);
  assert.equal(page.rooms[1].spectatorCount, 0);
  assert.equal(page.rooms[1].isCountApproximate, false);
  assert.equal(page.rooms[1].currentQuestionIndex, null);
  assert.equal(page.rooms[1].questionCount, null);
});

test("public room directory uses an opaque cursor to load additional bounded pages", async () => {
  const firstQuery = Array.from({ length: 21 }, (_, index) => room(
    `lobby-${String(index).padStart(2, "0")}`,
    "LOBBY",
    new Date(Date.UTC(2026, 7, 9, 9, 59 - index)).toISOString(),
  ));
  const secondQuery = Array.from({ length: 5 }, (_, index) => room(
    `lobby-${String(index + 20).padStart(2, "0")}`,
    "LOBBY",
    new Date(Date.UTC(2026, 7, 9, 9, 39 - index)).toISOString(),
  ));
  const { env, fetchedTopics, boundQueries } = createEnv([firstQuery, secondQuery], {});

  const firstPage = await listPublicRooms(env, null, NOW);
  assert.equal(firstPage.rooms.length, 20);
  assert.ok(firstPage.nextCursor);
  assert.equal(firstPage.rooms[0].id, "lobby-00");
  assert.equal(firstPage.rooms[19].id, "lobby-19");

  const secondPage = await listPublicRooms(env, firstPage.nextCursor, NOW);
  assert.deepEqual(secondPage.rooms.map(({ id }) => id), ["lobby-20", "lobby-21", "lobby-22", "lobby-23", "lobby-24"]);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(fetchedTopics.length, 0);
  assert.equal(boundQueries.length, 2);
  assert.equal(boundQueries[1][2], statusRank("LOBBY", null));
  assert.equal(boundQueries[1].at(-1), 21);
});

test("public room directory rejects malformed cursors without querying storage", async () => {
  const { env, boundQueries } = createEnv([[]], {});
  await assert.rejects(() => listPublicRooms(env, "not-a-cursor", NOW), /公开房间游标无效/);
  const previousOrderingCursor = Buffer.from(JSON.stringify({
    version: 2,
    statusRank: 0,
    updatedAt: "2026-08-09T09:00:00.000Z",
    createdAt: "2026-08-09T08:00:00.000Z",
    id: "old-ordering",
  })).toString("base64url");
  await assert.rejects(() => listPublicRooms(env, previousOrderingCursor, NOW), /公开房间游标无效/);
  assert.equal(boundQueries.length, 0);
});

test("public room directory caches a complete successful response for sixty seconds", async () => {
  const freshAt = new Date().toISOString();
  const { env, fetchedTopics, boundQueries } = createEnv([
    [room("playing-cache", "PLAYING", freshAt, 3)],
  ], {
    "room:playing-cache": Response.json({
      status: "PLAYING",
      playerCount: 7,
      spectatorCount: 2,
      updatedAt: freshAt,
      currentQuestionIndex: 2,
      questionCount: 30,
    }),
  });
  const { cache, entries, matchedKeys, writtenKeys } = createResponseCache();

  const firstResponse = await getPublicRoomsResponse(
    new Request("https://api.example.com/api/public-rooms?ignored=first", { headers: { origin: "https://first.example.com" } }),
    env,
    cache,
  );
  const secondResponse = await getPublicRoomsResponse(
    new Request("https://api.example.com/api/public-rooms?ignored=second", { headers: { origin: "https://second.example.com" } }),
    { ...env, ALLOWED_ORIGIN: "*" },
    cache,
  );

  assert.equal(firstResponse.headers.get("x-public-room-cache"), "MISS");
  assert.equal(secondResponse.headers.get("x-public-room-cache"), "HIT");
  assert.equal(firstResponse.headers.get("cache-control"), "no-store");
  assert.equal(secondResponse.headers.get("cache-control"), "no-store");
  assert.equal(firstResponse.headers.get("access-control-allow-origin"), "https://first.example.com");
  assert.equal(secondResponse.headers.get("access-control-allow-origin"), "https://second.example.com");
  assert.deepEqual(await firstResponse.json(), await secondResponse.json());
  assert.equal(boundQueries.length, 1);
  assert.deepEqual(fetchedTopics, ["room:playing-cache"]);
  assert.equal(matchedKeys.length, 2);
  assert.equal(writtenKeys.length, 1);
  assert.equal(matchedKeys[0], matchedKeys[1], "irrelevant query parameters and Origin must not fragment the shared cache");
  assert.match(matchedKeys[0], /cacheVersion=2/);
  assert.match(matchedKeys[0], /runtimeGeneration=/);
  assert.equal(entries.get(writtenKeys[0])?.headers.get("cache-control"), "public, max-age=60");
});

test("public room directory isolates each cursor in the shared cache", async () => {
  const baseTime = Date.now();
  const firstQuery = Array.from({ length: 21 }, (_, index) => room(
    `cache-page-${String(index).padStart(2, "0")}`,
    "LOBBY",
    new Date(baseTime - index * 1_000).toISOString(),
  ));
  const secondQuery = [room("cache-page-20", "LOBBY", new Date(baseTime - 20_000).toISOString())];
  const { env, boundQueries } = createEnv([firstQuery, secondQuery], {});
  const { cache, writtenKeys } = createResponseCache();

  const firstResponse = await getPublicRoomsResponse(new Request("https://api.example.com/api/public-rooms"), env, cache);
  const firstPage = await firstResponse.json() as { rooms: Array<{ id: string }>; nextCursor: string | null };
  assert.ok(firstPage.nextCursor);
  const secondResponse = await getPublicRoomsResponse(
    new Request(`https://api.example.com/api/public-rooms?cursor=${encodeURIComponent(firstPage.nextCursor)}`),
    env,
    cache,
  );
  const secondPage = await secondResponse.json() as { rooms: Array<{ id: string }>; nextCursor: string | null };
  const repeatedFirstResponse = await getPublicRoomsResponse(new Request("https://api.example.com/api/public-rooms"), env, cache);

  assert.equal(firstResponse.headers.get("x-public-room-cache"), "MISS");
  assert.equal(secondResponse.headers.get("x-public-room-cache"), "MISS");
  assert.equal(repeatedFirstResponse.headers.get("x-public-room-cache"), "HIT");
  assert.equal(firstPage.rooms[0].id, "cache-page-00");
  assert.deepEqual(secondPage.rooms.map(({ id }) => id), ["cache-page-20"]);
  assert.equal(boundQueries.length, 2);
  assert.equal(writtenKeys.length, 2);
  assert.notEqual(writtenKeys[0], writtenKeys[1]);
});

test("public room directory does not cache failures", async () => {
  let queryCount = 0;
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                queryCount += 1;
                throw new Error("temporary D1 failure");
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  const { cache, writtenKeys } = createResponseCache();
  const request = new Request("https://api.example.com/api/public-rooms");

  await assert.rejects(() => getPublicRoomsResponse(request, env, cache), /temporary D1 failure/);
  await assert.rejects(() => getPublicRoomsResponse(request, env, cache), /temporary D1 failure/);
  assert.equal(queryCount, 2);
  assert.equal(writtenKeys.length, 0);
});
