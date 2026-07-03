import { AsyncLocalStorage } from "node:async_hooks";
import { createRoomCode } from "../src/lib/id";
import { createD1QueryClient } from "./d1QueryCompat";
import type {
  Answer,
  BuzzerAnswer,
  DbAnswer,
  DbBuzzerAnswer,
  DbGameSession,
  DbPlayer,
  DbPlayerScore,
  DbQuestion,
  DbQuestionResult,
  DbQuestionSet,
  DbRoom,
  GameSession,
  GameMode,
  GameBootstrapSnapshot,
  LeaderboardEntry,
  Player,
  PlayerRole,
  PlayerScore,
  Question,
  QuestionResult,
  QuestionSet,
  RoundSnapshot,
  Room,
  TeamBattleGuessVote,
  TeamBattleState,
  TeamBattleTeam,
} from "../src/types/game";

type D1QueryClient = ReturnType<typeof createD1QueryClient>;
type DbQuestionSnapshot = {
  game_session_id: string;
  question_index: number;
  eligible_player_count: number;
  eligible_player_ids?: string | null;
  created_at: string;
};
type DbQuestionEligiblePlayer = {
  game_session_id: string;
  question_index: number;
  player_id: string;
  created_at: string;
};

const d1Context = new AsyncLocalStorage<D1QueryClient>();
const unboundD1 = createD1QueryClient(null);
const d1: D1QueryClient = {
  hasDatabase() {
    return getD1().hasDatabase();
  },
  from(table: string) {
    return getD1().from(table);
  },
};

function getD1() {
  return d1Context.getStore() ?? unboundD1;
}

export function runWithGameDatabase<T>(db: D1Database, callback: () => Promise<T>) {
  return d1Context.run(createD1QueryClient(db), callback);
}

function assertD1Env() {
  if (!d1.hasDatabase()) {
    throw new Error("数据库未连接，请确认服务已绑定游戏数据库。");
  }
}

function getD1PublicConfig(): never {
  throw new Error("当前版本不再支持直接访问数据库公共配置，请通过游戏服务操作房间。");
}

function toPlayer(player: DbPlayer): Player {
  return {
    id: player.id,
    roomId: player.room_id,
    nickname: player.nickname,
    isHost: player.is_host,
    role: normalizePlayerRole(player.role),
    joinedAt: player.joined_at,
    lastSeenAt: player.last_seen_at,
  };
}

function normalizePlayerRole(role: unknown): PlayerRole {
  return role === "SPECTATOR" ? "SPECTATOR" : "PLAYER";
}

function isPlayerRole(role: unknown): role is PlayerRole {
  return role === "PLAYER" || role === "SPECTATOR";
}

function isGamePlayer(player: Pick<DbPlayer, "role">) {
  return normalizePlayerRole(player.role) === "PLAYER";
}

function countGamePlayers(players: Pick<DbPlayer, "role">[]) {
  return players.filter(isGamePlayer).length;
}

function toRoom(room: DbRoom, players: DbPlayer[] = []): Room {
  return {
    id: room.id,
    code: room.room_code,
    hostPlayerId: room.host_player_id,
    players: players.map(toPlayer),
    status: room.game_status,
    currentPresenterPlayerId: room.current_presenter_player_id,
    currentGameId: room.current_game_id,
    preparedQuestionSetId: room.prepared_question_set_id ?? null,
    createdAt: room.created_at,
    updatedAt: room.updated_at,
  };
}

function toQuestion(question: DbQuestion): Question {
  return {
    id: question.id,
    questionSetId: question.question_set_id,
    imageUrl: question.image_url,
    orderIndex: question.order_index,
    labelText: question.label_text ?? null,
    labelSource: question.label_source ?? null,
    labelSourceAnswerId: question.label_source_answer_id ?? null,
    labelUpdatedByPlayerId: question.label_updated_by_player_id ?? null,
    labelUpdatedAt: question.label_updated_at ?? null,
    createdAt: question.created_at,
  };
}

function toQuestionSet(questionSet: DbQuestionSet, questions: DbQuestion[] = []): QuestionSet {
  const questionUrlsText = questions
    .slice()
    .sort((a, b) => a.order_index - b.order_index)
    .map((question) => question.image_url)
    .join("\n");

  return {
    id: questionSet.id,
    title: questionSet.title,
    description: questionSet.description,
    createdByPlayerId: questionSet.created_by_player_id,
    createdByNickname: questionSet.created_by_nickname ?? null,
    source: questionSet.source,
    isPublic: questionSet.is_public,
    imageUrlsText: questionSet.image_urls_text ?? questionUrlsText,
    imageCount: questionSet.image_count,
    ratingAvg: questionSet.rating_avg,
    ratingCount: questionSet.rating_count,
    createdAt: questionSet.created_at,
    updatedAt: questionSet.updated_at,
    questions: questions.map(toQuestion),
  };
}

async function getPlayerNickname(playerId: string, roomId?: string) {
  assertD1Env();

  let query = d1.from("players").select("*").eq("id", playerId);

  if (roomId) {
    query = query.eq("room_id", roomId);
  }

  const { data, error } = await query.maybeSingle<DbPlayer>();

  if (error) {
    throw new Error(error.message);
  }

  return data?.nickname.trim() || null;
}

function toGameSession(gameSession: DbGameSession): GameSession {
  const revealedBlocks = Array.isArray(gameSession.revealed_blocks)
    ? Array.from(
        new Set(
          gameSession.revealed_blocks.filter(
            (block): block is number => Number.isInteger(block) && block >= 0 && block < REVEAL_BLOCK_COUNT,
          ),
        ),
      ).sort((a, b) => a - b)
    : [];
  const roundScores = Array.isArray(gameSession.round_scores)
    ? gameSession.round_scores.filter((score): score is number => Number.isFinite(score))
    : [3, 2, 1];
  const teamBattleState = parseTeamBattleState(gameSession.team_battle_state);

  return {
    id: gameSession.id,
    roomId: gameSession.room_id,
    questionSetId: gameSession.question_set_id,
    presenterPlayerId: gameSession.presenter_player_id,
    status: gameSession.status,
    gameMode: gameSession.game_mode ?? "ROUND_REVEAL",
    currentQuestionIndex: gameSession.current_question_index,
    currentRevealRound: gameSession.current_reveal_round,
    revealedBlocks,
    maxRevealRounds: gameSession.max_reveal_rounds ?? 3,
    roundSeconds: gameSession.round_seconds ?? 60,
    roundScores,
    roundStartedAt: gameSession.round_started_at,
    serverNow: new Date().toISOString(),
    teamBattleState,
    createdAt: gameSession.created_at,
    endedAt: gameSession.ended_at,
  };
}

function parseTeamBattleState(value: unknown): TeamBattleState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Partial<TeamBattleState>;
  const teamsRecord = record.teams && typeof record.teams === "object" ? record.teams : null;
  const redTeam = Array.isArray(teamsRecord?.red) ? teamsRecord.red.filter((id): id is string => typeof id === "string") : [];
  const blueTeam = Array.isArray(teamsRecord?.blue) ? teamsRecord.blue.filter((id): id is string => typeof id === "string") : [];
  const teamMemberNames = normalizeTeamMemberNames(record.teamMemberNames);
  const activeTeam = record.activeTeam === "blue" ? "blue" : "red";
  const phase =
    record.phase === "GUESS_VOTE" || record.phase === "JUDGING" || record.phase === "REVIEW" ? record.phase : "REVEAL_VOTE";
  const teamScoresRecord = record.teamScores && typeof record.teamScores === "object" ? record.teamScores : null;

  return {
    teams: {
      red: redTeam,
      blue: blueTeam,
    },
    teamMemberNames,
    activeTeam,
    phase,
    revealLimit: Math.max(1, Math.min(10, Math.floor(Number(record.revealLimit) || 1))),
    turnNumber: Math.max(1, Math.floor(Number(record.turnNumber) || 1)),
    voteDeadlineAt: typeof record.voteDeadlineAt === "string" ? record.voteDeadlineAt : null,
    revealVotes: normalizeRevealVotes(record.revealVotes),
    guessVotes: normalizeGuessVotes(record.guessVotes),
    pendingGuess:
      record.pendingGuess &&
      typeof record.pendingGuess === "object" &&
      (record.pendingGuess.team === "red" || record.pendingGuess.team === "blue") &&
      typeof record.pendingGuess.answerText === "string"
        ? {
            team: record.pendingGuess.team,
            answerText: record.pendingGuess.answerText,
          }
        : null,
    teamScores: {
      red: Math.max(0, Math.floor(Number(teamScoresRecord?.red) || 0)),
      blue: Math.max(0, Math.floor(Number(teamScoresRecord?.blue) || 0)),
    },
    message: typeof record.message === "string" ? record.message : null,
  };
}

function normalizeTeamMemberNames(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const names: Record<string, string> = {};
  for (const [playerId, nickname] of Object.entries(value)) {
    if (typeof nickname === "string" && nickname.trim()) {
      names[playerId] = nickname.trim();
    }
  }

  return names;
}

function normalizeRevealVotes(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const votes: Record<string, number[]> = {};
  for (const [playerId, blocks] of Object.entries(value)) {
    if (Array.isArray(blocks)) {
      votes[playerId] = Array.from(
        new Set(blocks.filter((block): block is number => Number.isInteger(block) && block >= 0 && block < REVEAL_BLOCK_COUNT)),
      ).sort((a, b) => a - b);
    }
  }

  return votes;
}

function normalizeGuessVotes(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const votes: Record<string, TeamBattleGuessVote> = {};
  for (const [playerId, vote] of Object.entries(value)) {
    if (!vote || typeof vote !== "object" || Array.isArray(vote)) {
      continue;
    }

    const record = vote as Partial<TeamBattleGuessVote>;
    if (record.type === "skip") {
      votes[playerId] = { type: "skip" };
    } else if (record.type === "guess" && typeof record.answerText === "string" && record.answerText.trim()) {
      votes[playerId] = { type: "guess", answerText: record.answerText.trim() };
    }
  }

  return votes;
}

function randomInt(maxExclusive: number) {
  return Math.floor(Math.random() * maxExclusive);
}

function shuffleItems<T>(items: T[]) {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

function createInitialTeamBattleState(players: DbPlayer[], presenterPlayerId: string, previousScores?: Record<TeamBattleTeam, number>): TeamBattleState {
  const guessers = shuffleItems(players.filter((player) => isGamePlayer(player) && player.id !== presenterPlayerId));
  const largerTeamSize = Math.ceil(guessers.length / 2);
  const redGetsExtraPlayer = guessers.length % 2 === 1 ? randomInt(2) === 0 : true;
  const redTeamSize = redGetsExtraPlayer ? largerTeamSize : Math.floor(guessers.length / 2);
  const red = guessers.slice(0, redTeamSize).map((player) => player.id);
  const blue = guessers.slice(redTeamSize).map((player) => player.id);
  const teamMemberNames = Object.fromEntries(guessers.map((player) => [player.id, player.nickname.trim() || "已离开玩家"]));

  return {
    teams: { red, blue },
    teamMemberNames,
    activeTeam: "red",
    phase: "REVEAL_VOTE",
    revealLimit: 1,
    turnNumber: 1,
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    pendingGuess: null,
    teamScores: previousScores ?? { red: 0, blue: 0 },
    message: "红队先手，请投票选择要打开的方块。",
  };
}

async function resetTeamBattleStateForQuestion(state: TeamBattleState, roomId: string, presenterPlayerId: string): Promise<TeamBattleState> {
  const players = await getDbPlayersByRoomId(roomId);
  const activeGuessers = players.filter((player) => isGamePlayer(player) && player.id !== presenterPlayerId);
  const activeGuesserById = new Map(activeGuessers.map((player) => [player.id, player]));
  const assigned = new Set<string>();
  const teams: Record<TeamBattleTeam, string[]> = {
    red: [],
    blue: [],
  };

  for (const team of ["red", "blue"] as const) {
    for (const memberId of state.teams[team]) {
      if (activeGuesserById.has(memberId) && !assigned.has(memberId)) {
        teams[team].push(memberId);
        assigned.add(memberId);
      }
    }
  }

  const newGuessers = activeGuessers.filter((player) => !assigned.has(player.id));
  for (const player of newGuessers) {
    const targetTeam = teams.red.length <= teams.blue.length ? "red" : "blue";
    teams[targetTeam].push(player.id);
    assigned.add(player.id);
  }

  const teamMemberNames = Object.fromEntries(
    [...teams.red, ...teams.blue].map((playerId) => [
      playerId,
      activeGuesserById.get(playerId)?.nickname.trim() || state.teamMemberNames?.[playerId] || "已离开玩家",
    ]),
  );

  return {
    teams,
    teamMemberNames,
    activeTeam: "red",
    phase: "REVEAL_VOTE",
    revealLimit: 1,
    turnNumber: state.turnNumber + 1,
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    pendingGuess: null,
    teamScores: state.teamScores,
    message: newGuessers.length > 0
      ? "进入下一张图，新加入玩家已分配队伍，红队先手选择要打开的方块。"
      : "进入下一张图，红队先手选择要打开的方块。",
  };
}

function getOpposingTeam(team: TeamBattleTeam): TeamBattleTeam {
  return team === "red" ? "blue" : "red";
}

function getTeamName(team: TeamBattleTeam) {
  return team === "red" ? "红队" : "蓝队";
}

function getTeamMembers(state: TeamBattleState, team: TeamBattleTeam) {
  return state.teams[team] ?? [];
}

function getPlayerTeam(state: TeamBattleState, playerId: string): TeamBattleTeam | null {
  if (state.teams.red.includes(playerId)) {
    return "red";
  }
  if (state.teams.blue.includes(playerId)) {
    return "blue";
  }
  return null;
}

function isTeamVotingComplete(state: TeamBattleState, votes: Record<string, unknown>) {
  const members = getTeamMembers(state, state.activeTeam);
  return members.length > 0 && members.every((memberId) => Object.prototype.hasOwnProperty.call(votes, memberId));
}

function withVoteDeadlineIfComplete(state: TeamBattleState, votes: Record<string, unknown>) {
  if (state.voteDeadlineAt || !isTeamVotingComplete(state, votes)) {
    return state;
  }

  return {
    ...state,
    voteDeadlineAt: new Date(Date.now() + TEAM_BATTLE_VOTE_GRACE_SECONDS * 1000).toISOString(),
    message: `${getTeamName(state.activeTeam)}所有成员都已提交，进入 ${TEAM_BATTLE_VOTE_GRACE_SECONDS} 秒自由修改时间。`,
  };
}

function removePlayerFromTeamBattleState(state: TeamBattleState, playerId: string): TeamBattleState {
  const teams = {
    red: state.teams.red.filter((memberId) => memberId !== playerId),
    blue: state.teams.blue.filter((memberId) => memberId !== playerId),
  };

  if (teams.red.length === state.teams.red.length && teams.blue.length === state.teams.blue.length) {
    return state;
  }

  const revealVotes = { ...state.revealVotes };
  const guessVotes = { ...state.guessVotes };
  const teamMemberNames = { ...(state.teamMemberNames ?? {}) };
  delete revealVotes[playerId];
  delete guessVotes[playerId];
  delete teamMemberNames[playerId];

  let nextState: TeamBattleState = {
    ...state,
    teams,
    teamMemberNames,
    revealVotes,
    guessVotes,
  };

  if (teams[nextState.activeTeam].length === 0) {
    const nextTeam = getOpposingTeam(nextState.activeTeam);
    if (teams[nextTeam].length > 0) {
      nextState = {
        ...nextState,
        activeTeam: nextTeam,
        voteDeadlineAt: null,
        revealVotes: {},
        guessVotes: {},
        pendingGuess: null,
        message: `${getTeamName(getOpposingTeam(nextTeam))}没有在线队员，轮到${getTeamName(nextTeam)}。`,
      };
    }
  }

  const currentVotes =
    nextState.phase === "REVEAL_VOTE" ? nextState.revealVotes : nextState.phase === "GUESS_VOTE" ? nextState.guessVotes : null;

  return currentVotes ? withVoteDeadlineIfComplete(nextState, currentVotes) : nextState;
}

async function removePlayerFromCurrentTeamBattle(gameSessionId: string, playerId: string) {
  const { data: gameSession, error } = await d1.from("game_sessions").select("*").eq("id", gameSessionId).maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!gameSession || gameSession.status !== "PLAYING" || gameSession.game_mode !== "TEAM_BATTLE") {
    return;
  }

  const state = parseTeamBattleState(gameSession.team_battle_state);
  if (!state) {
    return;
  }

  const nextState = removePlayerFromTeamBattleState(state, playerId);
  if (nextState === state) {
    return;
  }

  const { error: updateError } = await updateTeamBattleState(gameSessionId, nextState);
  if (updateError) {
    throw new Error(updateError.message);
  }
}

async function assertRemovingPlayerKeepsTeamBattlePlayable(gameSessionId: string, playerId: string) {
  const { data: gameSession, error } = await d1.from("game_sessions").select("*").eq("id", gameSessionId).maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!gameSession || gameSession.status !== "PLAYING" || gameSession.game_mode !== "TEAM_BATTLE") {
    return;
  }

  const state = parseTeamBattleState(gameSession.team_battle_state);
  if (!state) {
    return;
  }

  const playerTeam = getPlayerTeam(state, playerId);
  if (playerTeam && getTeamMembers(state, playerTeam).length <= 1) {
    throw new Error("踢出该玩家会导致队伍为空，请取消本局后重新开始。");
  }
}

async function removePlayerFromCurrentGame(gameSessionId: string, playerId: string) {
  const { data: gameSession, error } = await d1.from("game_sessions").select("*").eq("id", gameSessionId).maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!gameSession || gameSession.status !== "PLAYING") {
    return;
  }

  if (gameSession.game_mode === "TEAM_BATTLE") {
    await removePlayerFromCurrentTeamBattle(gameSession.id, playerId);
  }
}

function assertTeamBattleSession(gameSession: DbGameSession) {
  const session = toGameSession(gameSession);
  if (session.gameMode !== "TEAM_BATTLE" || !session.teamBattleState) {
    throw new Error("当前游戏不是红蓝对抗模式，不能执行该操作。");
  }
  return session;
}

function voteDeadlineReached(state: TeamBattleState) {
  return Boolean(state.voteDeadlineAt && Date.now() >= new Date(state.voteDeadlineAt).getTime());
}

function randomChoice<T>(items: T[]) {
  return items[randomInt(items.length)];
}

function isForfeitAnswer(answer: Pick<DbAnswer, "answer_text"> | Pick<Answer, "answerText">) {
  return "answer_text" in answer ? answer.answer_text === FORFEIT_ANSWER_TEXT : answer.answerText === FORFEIT_ANSWER_TEXT;
}

function getCorrectAnswersForLabel<T extends { player_id: string; submitted_at: string; reveal_round: number; id: string }>(
  answers: T[],
  questionResults: DbQuestionResult[],
) {
  const correctAnswerKeySet = new Set(
    questionResults.map((result) => getPlayerRoundAnswerKey(result.player_id, result.scored_round)),
  );

  return answers
    .filter((answer) => correctAnswerKeySet.has(getPlayerRoundAnswerKey(answer.player_id, answer.reveal_round)))
    .sort(compareAnswerOrder);
}

function getPlayerRoundAnswerKey(playerId: string, revealRound: number) {
  return `${playerId}:${revealRound}`;
}

function compareAnswerOrder(
  left: { submitted_at: string; reveal_round: number; id: string },
  right: { submitted_at: string; reveal_round: number; id: string },
) {
  const submittedAtDiff = new Date(left.submitted_at).getTime() - new Date(right.submitted_at).getTime();
  if (Number.isFinite(submittedAtDiff) && submittedAtDiff !== 0) {
    return submittedAtDiff;
  }

  const submittedAtTextDiff = left.submitted_at.localeCompare(right.submitted_at);
  if (submittedAtTextDiff !== 0) {
    return submittedAtTextDiff;
  }

  return left.reveal_round - right.reveal_round || left.id.localeCompare(right.id);
}

function canUseForfeitAnswer(gameMode: GameMode) {
  return gameMode !== "TEAM_BATTLE";
}

function isBuzzerAnswerReadyForJudging(answer: Pick<DbBuzzerAnswer, "submitted_at">, nowMs = Date.now()) {
  return nowMs - new Date(answer.submitted_at).getTime() >= BUZZER_JUDGING_STABILIZE_MS;
}

function parseEligiblePlayerIds(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((playerId): playerId is string => typeof playerId === "string") : null;
  } catch {
    return null;
  }
}

function getQuestionEligiblePlayerIdsFromSnapshot(snapshot: DbQuestionSnapshot) {
  const playerIds = parseEligiblePlayerIds(snapshot.eligible_player_ids);
  return playerIds ?? null;
}

function isMissingEligibilityTableError(error: { message?: string } | null) {
  const message = error?.message ?? "";
  return /no such table/i.test(message) && /question_(snapshots|eligible_players)/i.test(message);
}

async function getCurrentRoomEligiblePlayerIds(roomId: string, presenterPlayerId: string) {
  const { data: players, error: playersError } = await d1
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true })
    .returns<DbPlayer[]>();

  if (playersError) {
    throw new Error(playersError.message);
  }

  return (players ?? [])
    .filter((player) => isGamePlayer(player) && player.id !== presenterPlayerId)
    .map((player) => player.id);
}

async function getQuestionEligiblePlayerIdsFromDb(gameSessionId: string, questionIndex: number) {
  const { data, error } = await d1
    .from("question_eligible_players")
    .select("*")
    .eq("game_session_id", gameSessionId)
    .eq("question_index", questionIndex)
    .order("created_at", { ascending: true })
    .returns<DbQuestionEligiblePlayer[]>();

  if (error) {
    if (isMissingEligibilityTableError(error)) {
      return null;
    }

    throw new Error(error.message);
  }

  return (data ?? []).map((row) => row.player_id);
}

async function insertQuestionEligibilitySnapshot(params: {
  gameSessionId: string;
  questionIndex: number;
  eligiblePlayerIds: string[];
}) {
  const { error: snapshotError } = await d1.from("question_snapshots").insert(
    {
      game_session_id: params.gameSessionId,
      question_index: params.questionIndex,
      eligible_player_count: params.eligiblePlayerIds.length,
      eligible_player_ids: JSON.stringify(params.eligiblePlayerIds),
    },
  );

  if (snapshotError) {
    if (isMissingEligibilityTableError(snapshotError)) {
      return params.eligiblePlayerIds;
    }

    if (isUniqueViolation(snapshotError)) {
      const { data: existingSnapshot, error: existingSnapshotError } = await d1
        .from("question_snapshots")
        .select("*")
        .eq("game_session_id", params.gameSessionId)
        .eq("question_index", params.questionIndex)
        .maybeSingle<DbQuestionSnapshot>();

      if (existingSnapshotError) {
        if (isMissingEligibilityTableError(existingSnapshotError)) {
          return params.eligiblePlayerIds;
        }

        throw new Error(existingSnapshotError.message);
      }

      if (existingSnapshot) {
        return getQuestionEligiblePlayerIdsFromSnapshot(existingSnapshot) ??
          await getQuestionEligiblePlayerIdsFromDb(params.gameSessionId, params.questionIndex) ??
          params.eligiblePlayerIds;
      }
    }

    throw new Error(snapshotError.message);
  }

  if (params.eligiblePlayerIds.length > 0) {
    const { error: eligiblePlayersError } = await d1.from("question_eligible_players").upsert(
      params.eligiblePlayerIds.map((playerId) => ({
        game_session_id: params.gameSessionId,
        question_index: params.questionIndex,
        player_id: playerId,
      })),
      {
        onConflict: "game_session_id,question_index,player_id",
      },
    );

    if (eligiblePlayersError) {
      if (isMissingEligibilityTableError(eligiblePlayersError)) {
        return params.eligiblePlayerIds;
      }

      throw new Error(eligiblePlayersError.message);
    }
  }

  return params.eligiblePlayerIds;
}

async function createQuestionEligibilitySnapshot(params: {
  gameSessionId: string;
  roomId: string;
  questionIndex: number;
  presenterPlayerId: string;
}) {
  const eligiblePlayerIds = await getCurrentRoomEligiblePlayerIds(params.roomId, params.presenterPlayerId);

  return await insertQuestionEligibilitySnapshot({
    gameSessionId: params.gameSessionId,
    questionIndex: params.questionIndex,
    eligiblePlayerIds,
  });
}

async function createQuestionEligibilitySnapshotFromPlayers(params: {
  gameSessionId: string;
  questionIndex: number;
  presenterPlayerId: string;
  players: DbPlayer[];
}) {
  const eligiblePlayerIds = params.players
    .filter((player) => isGamePlayer(player) && player.id !== params.presenterPlayerId)
    .map((player) => player.id);

  return await insertQuestionEligibilitySnapshot({
    gameSessionId: params.gameSessionId,
    questionIndex: params.questionIndex,
    eligiblePlayerIds,
  });
}

async function getOrCreateQuestionEligiblePlayerIds(params: {
  gameSessionId: string;
  roomId: string;
  questionIndex: number;
  presenterPlayerId: string;
  knownEligiblePlayerIds?: string[];
}) {
  if (params.knownEligiblePlayerIds) {
    return params.knownEligiblePlayerIds;
  }

  const { data: snapshot, error: snapshotError } = await d1
    .from("question_snapshots")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .maybeSingle<DbQuestionSnapshot>();

  if (snapshotError) {
    if (isMissingEligibilityTableError(snapshotError)) {
      return await getCurrentRoomEligiblePlayerIds(params.roomId, params.presenterPlayerId);
    }

    throw new Error(snapshotError.message);
  }

  if (snapshot) {
    return getQuestionEligiblePlayerIdsFromSnapshot(snapshot) ??
      await getQuestionEligiblePlayerIdsFromDb(params.gameSessionId, params.questionIndex) ??
      await getCurrentRoomEligiblePlayerIds(params.roomId, params.presenterPlayerId);
  }

  return await createQuestionEligibilitySnapshot(params);
}

async function hydrateGameSessionEligibility(gameSession: GameSession) {
  const eligiblePlayerIds = await getOrCreateQuestionEligiblePlayerIds({
    gameSessionId: gameSession.id,
    roomId: gameSession.roomId,
    questionIndex: gameSession.currentQuestionIndex,
    presenterPlayerId: gameSession.presenterPlayerId,
    knownEligiblePlayerIds: gameSession.eligiblePlayerIds,
  });

  return {
    ...gameSession,
    eligiblePlayerIds,
  };
}

async function getEligiblePlayerSetForCurrentQuestion(gameSession: GameSession) {
  const eligiblePlayerIds = await getOrCreateQuestionEligiblePlayerIds({
    gameSessionId: gameSession.id,
    roomId: gameSession.roomId,
    questionIndex: gameSession.currentQuestionIndex,
    presenterPlayerId: gameSession.presenterPlayerId,
    knownEligiblePlayerIds: gameSession.eligiblePlayerIds,
  });

  return new Set(eligiblePlayerIds);
}

async function assertPlayerEligibleForCurrentQuestion(gameSession: GameSession, playerId: string) {
  const eligiblePlayerSet = await getEligiblePlayerSetForCurrentQuestion(gameSession);

  if (!eligiblePlayerSet.has(playerId)) {
    throw new Error("你是本题开始后加入的玩家，本题不能作答，请等待下一题。");
  }
}

async function assertGamePlayerInRoom(roomId: string, playerId: string) {
  const { data: player, error } = await d1
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .eq("id", playerId)
    .maybeSingle<DbPlayer>();

  if (error) {
    throw new Error(error.message);
  }

  if (!player || !isGamePlayer(player)) {
    throw new Error("观战者不能执行玩家操作。");
  }

  return player;
}

async function getRoundActionState(gameSession: GameSession) {
  const [
    { data: questionResults, error: resultsError },
    { data: currentRoundBuzzerAnswers, error: buzzerAnswersError },
    { data: currentRoundAnswers, error: answersError },
    { data: roomPlayers, error: roomPlayersError },
    guesserIds,
  ] = await Promise.all([
    d1
      .from("question_results")
      .select("player_id")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", gameSession.currentQuestionIndex)
      .returns<Pick<DbQuestionResult, "player_id">[]>(),
    d1
      .from("buzzer_answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", gameSession.currentQuestionIndex)
      .eq("reveal_round", gameSession.currentRevealRound)
      .returns<DbBuzzerAnswer[]>(),
    d1
      .from("answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", gameSession.currentQuestionIndex)
      .eq("reveal_round", gameSession.currentRevealRound)
      .returns<DbAnswer[]>(),
    d1
      .from("players")
      .select("*")
      .eq("room_id", gameSession.roomId)
      .returns<DbPlayer[]>(),
    getOrCreateQuestionEligiblePlayerIds({
      gameSessionId: gameSession.id,
      roomId: gameSession.roomId,
      questionIndex: gameSession.currentQuestionIndex,
      presenterPlayerId: gameSession.presenterPlayerId,
      knownEligiblePlayerIds: gameSession.eligiblePlayerIds,
    }),
  ]);

  if (resultsError) {
    throw new Error(resultsError.message);
  }
  if (buzzerAnswersError) {
    throw new Error(buzzerAnswersError.message);
  }
  if (answersError) {
    throw new Error(answersError.message);
  }
  if (roomPlayersError) {
    throw new Error(roomPlayersError.message);
  }

  const correctSet = new Set((questionResults ?? []).map((result) => result.player_id));
  const activeRoomPlayerSet = new Set((roomPlayers ?? []).filter(isGamePlayer).map((player) => player.id));
  const activeGuesserIds = guesserIds.filter((guesserId) => activeRoomPlayerSet.has(guesserId));
  const guesserIdSet = new Set(activeGuesserIds);
  const activeCurrentRoundBuzzerAnswers = (currentRoundBuzzerAnswers ?? []).filter((answer) => guesserIdSet.has(answer.player_id));
  const activeCurrentRoundAnswers = (currentRoundAnswers ?? []).filter((answer) => guesserIdSet.has(answer.player_id));
  const eligibleGuesserIds = activeGuesserIds.filter((guesserId) => !correctSet.has(guesserId));
  const buzzerAnswerByPlayerId = new Map(activeCurrentRoundBuzzerAnswers.map((answer) => [answer.player_id, answer]));
  const answerByPlayerId = new Map(activeCurrentRoundAnswers.map((answer) => [answer.player_id, answer]));
  const hasPlayerActed = (guesserId: string) =>
    gameSession.gameMode === "ROUND_REVEAL"
      ? answerByPlayerId.has(guesserId)
      : answerByPlayerId.has(guesserId) || buzzerAnswerByPlayerId.has(guesserId);

  return {
    guesserIds: activeGuesserIds,
    correctSet,
    eligibleGuesserIds,
    currentRoundBuzzerAnswers: activeCurrentRoundBuzzerAnswers,
    currentRoundAnswers: activeCurrentRoundAnswers,
    buzzerAnswerByPlayerId,
    answerByPlayerId,
    hasPendingAnswers: activeCurrentRoundBuzzerAnswers.some((answer) => answer.status === "pending"),
    allEligiblePlayersUsedChance:
      eligibleGuesserIds.length === 0 || eligibleGuesserIds.every((guesserId) => hasPlayerActed(guesserId)),
    hasPlayerActed,
  };
}

async function hasCorrectResultForCurrentQuestion(gameSession: GameSession) {
  const { data, error } = await d1
    .from("question_results")
    .select("id")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

async function areAllGuessersCorrectForQuestion(params: {
  roomId: string;
  gameSessionId: string;
  questionIndex: number;
  presenterPlayerId: string;
}) {
  const [guesserIds, { data: questionResults, error: questionResultsError }] = await Promise.all([
    getOrCreateQuestionEligiblePlayerIds(params),
    d1
      .from("question_results")
      .select("player_id")
      .eq("game_session_id", params.gameSessionId)
      .eq("question_index", params.questionIndex)
      .returns<Pick<DbQuestionResult, "player_id">[]>(),
  ]);

  if (questionResultsError) {
    throw new Error(questionResultsError.message);
  }

  const correctSet = new Set((questionResults ?? []).map((result) => result.player_id));

  return guesserIds.length > 0 && guesserIds.every((guesserId) => correctSet.has(guesserId));
}

function updateTeamBattleState(gameSessionId: string, state: TeamBattleState, extra?: Record<string, unknown>) {
  return d1
    .from("game_sessions")
    .update({
      team_battle_state: state,
      ...extra,
    })
    .eq("id", gameSessionId)
    .eq("status", "PLAYING")
    .select()
    .single<DbGameSession>();
}

function toBuzzerAnswer(answer: DbBuzzerAnswer): BuzzerAnswer {
  return {
    id: answer.id,
    gameSessionId: answer.game_session_id,
    questionIndex: answer.question_index,
    revealRound: answer.reveal_round,
    playerId: answer.player_id,
    answerText: answer.answer_text,
    status: answer.status,
    scoreAwarded: answer.score_awarded,
    submittedAt: answer.submitted_at,
    judgedAt: answer.judged_at,
    judgedByPlayerId: answer.judged_by_player_id,
  };
}

function toAnswer(answer: DbAnswer): Answer {
  return {
    id: answer.id,
    gameSessionId: answer.game_session_id,
    questionIndex: answer.question_index,
    revealRound: answer.reveal_round,
    playerId: answer.player_id,
    answerText: answer.answer_text,
    submittedAt: answer.submitted_at,
  };
}

function toPlayerScore(playerScore: DbPlayerScore): PlayerScore {
  return {
    id: playerScore.id,
    gameSessionId: playerScore.game_session_id,
    playerId: playerScore.player_id,
    score: playerScore.score,
    correctCount: playerScore.correct_count,
  };
}

function toQuestionResult(questionResult: DbQuestionResult): QuestionResult {
  return {
    id: questionResult.id,
    gameSessionId: questionResult.game_session_id,
    questionIndex: questionResult.question_index,
    playerId: questionResult.player_id,
    scoredRound: questionResult.scored_round,
    scoreAwarded: questionResult.score_awarded,
    judgedByPlayerId: questionResult.judged_by_player_id,
    judgedAt: questionResult.judged_at,
  };
}

function isUniqueViolation(error: { code?: string } | null) {
  return error?.code === "23505";
}

const REVEAL_BLOCK_COUNT = 45;
const ALL_REVEALED_BLOCKS = Array.from({ length: REVEAL_BLOCK_COUNT }, (_, index) => index);
const MAX_PLAYERS_PER_ROOM = 15;
const TEAM_BATTLE_VOTE_GRACE_SECONDS = 5;
const BUZZER_CLIENT_TIME_MAX_EARLY_MS = 5000;
const BUZZER_JUDGING_STABILIZE_MS = 3000;
const FORFEIT_ANSWER_TEXT = "__FORFEIT__";

export type QuestionImportItem = {
  imageUrl: string;
  labelText?: string | null;
};

function isHttpImageUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseImageUrlsText(imageUrlsText: string) {
  return Array.from(
    new Set(
      imageUrlsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && isHttpImageUrl(line)),
    ),
  );
}

function normalizeQuestionImportItems(items: QuestionImportItem[]) {
  const seenUrls = new Set<string>();
  const normalizedItems: QuestionImportItem[] = [];

  for (const item of items) {
    const imageUrl = item.imageUrl.trim();

    if (!imageUrl || !isHttpImageUrl(imageUrl) || seenUrls.has(imageUrl)) {
      continue;
    }

    seenUrls.add(imageUrl);
    normalizedItems.push({
      imageUrl,
      labelText: item.labelText?.trim() || null,
    });
  }

  return normalizedItems;
}

export function parseQuestionImportText(importText: string): QuestionImportItem[] {
  const items: QuestionImportItem[] = [];

  for (const [index, rawLine] of importText.split(/\r?\n/).entries()) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    if (!line.startsWith("{")) {
      if (isHttpImageUrl(line)) {
        items.push({ imageUrl: line });
      }
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`第 ${index + 1} 行不是有效 JSON。`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(`第 ${index + 1} 行必须是 JSON 对象。`);
    }

    const record = parsed as Record<string, unknown>;

    if (typeof record.image_url !== "string" || !isHttpImageUrl(record.image_url.trim())) {
      throw new Error(`第 ${index + 1} 行缺少有效的 image_url。`);
    }

    if (record.label_text != null && typeof record.label_text !== "string") {
      throw new Error(`第 ${index + 1} 行的 label_text 必须是字符串。`);
    }

    const labelText = typeof record.label_text === "string" ? record.label_text : null;

    items.push({
      imageUrl: record.image_url,
      labelText,
    });
  }

  return normalizeQuestionImportItems(items);
}

function imageUrlsToText(imageUrls: string[]) {
  return imageUrls.map((url) => url.trim()).filter(Boolean).join("\n");
}

export async function createRoom(playerId: string, nickname: string) {
  assertD1Env();

  let roomCode = createRoomCode();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data: room, error: roomError } = await d1
      .from("rooms")
      .insert({
        room_code: roomCode,
        host_player_id: playerId,
      })
      .select()
      .single<DbRoom>();

    if (roomError) {
      if (isUniqueViolation(roomError)) {
        roomCode = createRoomCode();
        continue;
      }

      throw new Error(roomError.message);
    }

    const { error: playerError } = await d1.from("players").upsert(
      {
        id: playerId,
        room_id: room.id,
        nickname,
        is_host: true,
        role: "PLAYER",
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );

    if (playerError) {
      throw new Error(playerError.message);
    }

    return toRoom(room, [
      {
        id: playerId,
        room_id: room.id,
        nickname,
        is_host: true,
        role: "PLAYER",
        joined_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      },
    ]);
  }

  throw new Error("创建房间失败：连续生成的房间号都已被占用，请重试。");
}

export async function getRoomByCode(roomCode: string) {
  assertD1Env();

  const { data: room, error } = await d1
    .from("rooms")
    .select("*")
    .eq("room_code", roomCode)
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  return room;
}

export async function getRoomWithPlayers(roomCode: string) {
  const room = await getRoomByCode(roomCode);

  if (!room) {
    return null;
  }

  const players = await getDbPlayersByRoomId(room.id);
  return toRoom(room, players);
}

async function getDbPlayersByRoomId(roomId: string) {
  assertD1Env();

  const { data, error } = await d1
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true })
    .order("id", { ascending: true })
    .returns<DbPlayer[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function getPlayersByRoomId(roomId: string) {
  const players = await getDbPlayersByRoomId(roomId);
  return players.map(toPlayer);
}

export async function joinRoom(roomCode: string, playerId: string, nickname: string, role?: PlayerRole) {
  const room = await getRoomByCode(roomCode);

  if (!room) {
    return {
      room: null,
      error: "房间不存在，请检查房间号是否正确。",
    };
  }

  const players = await getDbPlayersByRoomId(room.id);
  const duplicatedNickname = players.some(
    (player) => player.id !== playerId && player.nickname.trim().toLowerCase() === nickname.trim().toLowerCase(),
  );

  if (duplicatedNickname) {
    return {
      room: null,
      error: "该昵称已在房间内使用，请换一个昵称。",
    };
  }

  const existingPlayer = players.find((player) => player.id === playerId);
  const isExistingPlayer = Boolean(existingPlayer);
  const requestedRole = isPlayerRole(role) ? role : "PLAYER";
  let nextRole = existingPlayer ? normalizePlayerRole(existingPlayer.role) : requestedRole;

  if (existingPlayer && role && requestedRole !== nextRole) {
    const canSwitchRole = room.game_status === "LOBBY" || room.game_status === "QUESTION_SETUP";
    if (!canSwitchRole) {
      return {
        room: null,
        error: "游戏进行中不能切换玩家/观战身份。",
      };
    }
    if (room.game_status === "QUESTION_SETUP" && existingPlayer.id === room.current_presenter_player_id) {
      return {
        room: null,
        error: "当前出题人不能切换为观战身份。",
      };
    }
    nextRole = requestedRole;
  }

  if (nextRole === "PLAYER" && (!existingPlayer || !isGamePlayer(existingPlayer)) && countGamePlayers(players) >= MAX_PLAYERS_PER_ROOM) {
    return {
      room: null,
      error: `玩家已满，最多支持 ${MAX_PLAYERS_PER_ROOM} 名玩家；可以选择观战加入。`,
    };
  }

  const isHost = room.host_player_id === playerId;
  const { error } = await d1.from("players").upsert(
    {
      id: playerId,
      room_id: room.id,
      nickname,
      is_host: isHost,
      role: nextRole,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  if (error) {
    if (isUniqueViolation(error)) {
      return {
        room: null,
        error: "该玩家已经在其他房间中，请先退出原房间后再加入。",
      };
    }

    throw new Error(error.message);
  }

  const nextPlayers = await getDbPlayersByRoomId(room.id);

  return {
    room: toRoom(room, nextPlayers),
    error: null,
  };
}

export async function leaveRoom(roomId: string, playerId: string) {
  assertD1Env();

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    return null;
  }

  const isLeavingPresenter = room.current_presenter_player_id === playerId;
  if (isLeavingPresenter && room.game_status === "PLAYING") {
    throw new Error("游戏进行中，出题人不能直接离开房间。");
  }

  const isLeavingHost = room.host_player_id === playerId;
  const { error: deleteError } = await d1
    .from("players")
    .delete()
    .eq("room_id", roomId)
    .eq("id", playerId);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  const remainingPlayers = await getDbPlayersByRoomId(roomId);

  if (room.game_status === "PLAYING" && room.current_game_id) {
    await removePlayerFromCurrentGame(room.current_game_id, playerId);
  }

  if (!isLeavingHost && !(isLeavingPresenter && room.game_status === "QUESTION_SETUP")) {
    return toRoom(room, remainingPlayers);
  }

  const currentHostStillPresent = remainingPlayers.some((player) => player.id === room.host_player_id);
  const shouldPromoteHost = isLeavingHost || !currentHostStillPresent;
  const nextHost = shouldPromoteHost
    ? remainingPlayers[0] ?? null
    : remainingPlayers.find((player) => player.id === room.host_player_id) ?? null;

  if (!nextHost) {
    const { error: roomDeleteError } = await d1.from("rooms").delete().eq("id", roomId);
    if (roomDeleteError) {
      throw new Error(roomDeleteError.message);
    }
    return null;
  }

  if (shouldPromoteHost) {
    const { error: hostPlayerError } = await d1
      .from("players")
      .update({ is_host: true })
      .eq("room_id", roomId)
      .eq("id", nextHost.id);

    if (hostPlayerError) {
      throw new Error(hostPlayerError.message);
    }
  }

  const roomUpdates: Partial<DbRoom> = { host_player_id: nextHost.id };
  if (isLeavingPresenter && room.game_status === "QUESTION_SETUP") {
    roomUpdates.game_status = "LOBBY";
    roomUpdates.current_presenter_player_id = null;
    roomUpdates.prepared_question_set_id = null;
  }

  const { data: updatedRoom, error: hostRoomError } = await d1
    .from("rooms")
    .update(roomUpdates)
    .eq("id", roomId)
    .select()
    .maybeSingle<DbRoom>();

  if (hostRoomError) {
    throw new Error(hostRoomError.message);
  }

  if (!updatedRoom) {
    throw new Error("退出房间失败：房间状态已变化，请刷新后重试。");
  }

  return toRoom(updatedRoom, await getDbPlayersByRoomId(roomId));
}

export async function kickPlayerFromRoom(roomId: string, hostPlayerId: string, targetPlayerId: string) {
  assertD1Env();

  if (!targetPlayerId) {
    throw new Error("请选择要踢出的玩家。");
  }

  if (hostPlayerId === targetPlayerId) {
    throw new Error("房主不能踢出自己，如需退出请解散房间。");
  }

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    throw new Error("踢出玩家失败：房间不存在或已被解散。");
  }

  if (room.host_player_id !== hostPlayerId) {
    throw new Error("只有房主可以踢出玩家。");
  }

  const { data: targetPlayer, error: targetError } = await d1
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .eq("id", targetPlayerId)
    .maybeSingle<DbPlayer>();

  if (targetError) {
    throw new Error(targetError.message);
  }

  if (!targetPlayer) {
    throw new Error("踢出玩家失败：该玩家已不在房间。");
  }

  if (targetPlayer.is_host || targetPlayer.id === room.host_player_id) {
    throw new Error("不能踢出房主。");
  }

  if (room.game_status === "PLAYING" && room.current_presenter_player_id === targetPlayerId) {
    throw new Error("游戏进行中不能踢出当前出题人。如出题人掉线，请房主取消本局。");
  }

  if (room.game_status === "PLAYING" && room.current_game_id) {
    await assertRemovingPlayerKeepsTeamBattlePlayable(room.current_game_id, targetPlayerId);
  }

  const { error: deleteError } = await d1
    .from("players")
    .delete()
    .eq("room_id", roomId)
    .eq("id", targetPlayerId);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  let updatedRoom = room;
  if (room.game_status === "PLAYING" && room.current_game_id) {
    await removePlayerFromCurrentGame(room.current_game_id, targetPlayerId);
  }

  if (room.current_presenter_player_id === targetPlayerId && room.game_status === "QUESTION_SETUP") {
    const { data: resetRoom, error: resetError } = await d1
      .from("rooms")
      .update({
        current_presenter_player_id: null,
        current_game_id: null,
        prepared_question_set_id: null,
        game_status: "LOBBY",
      })
      .eq("id", roomId)
      .eq("host_player_id", hostPlayerId)
      .select()
      .maybeSingle<DbRoom>();

    if (resetError) {
      throw new Error(resetError.message);
    }

    if (!resetRoom) {
      throw new Error("踢出玩家失败：房间状态已变化，请刷新后重试。");
    }

    updatedRoom = resetRoom;
  }

  return toRoom(updatedRoom, await getDbPlayersByRoomId(roomId));
}

export async function dissolveRoom(roomId: string, playerId: string) {
  assertD1Env();

  const { error } = await d1
    .from("rooms")
    .delete()
    .eq("id", roomId)
    .eq("host_player_id", playerId);

  if (error) {
    throw new Error(error.message);
  }
}

export function dissolveRoomOnPageExit(roomId: string, playerId: string) {
  try {
    const { d1Url, d1AnonKey } = getD1PublicConfig();
    const url = new URL(`${d1Url}/rest/v1/rooms`);
    url.searchParams.set("id", `eq.${roomId}`);
    url.searchParams.set("host_player_id", `eq.${playerId}`);

    void fetch(url.toString(), {
      method: "DELETE",
      keepalive: true,
      headers: {
        apikey: d1AnonKey,
        Authorization: `Bearer ${d1AnonKey}`,
        Prefer: "return=minimal",
      },
    });
  } catch {
    // Page-exit cleanup is best effort; explicit host navigation still awaits dissolveRoom.
  }
}

export async function selectPresenterForRound(roomId: string, hostPlayerId: string, presenterPlayerId: string) {
  assertD1Env();

  const { data: presenter, error: presenterError } = await d1
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .eq("id", presenterPlayerId)
    .maybeSingle<DbPlayer>();

  if (presenterError) {
    throw new Error(presenterError.message);
  }

  if (!presenter) {
    throw new Error("选择出题人失败：该玩家不在当前房间。");
  }

  if (!isGamePlayer(presenter)) {
    throw new Error("选择出题人失败：观战者不能当出题人。");
  }

  const { data: room, error } = await d1
    .from("rooms")
    .update({
      current_presenter_player_id: presenterPlayerId,
      game_status: "QUESTION_SETUP",
      current_game_id: null,
      prepared_question_set_id: null,
    })
    .eq("id", roomId)
    .eq("host_player_id", hostPlayerId)
    .eq("game_status", "LOBBY")
    .select()
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  if (!room) {
    throw new Error("只有房主可以在大厅阶段选择出题人。");
  }

  return toRoom(room);
}

export async function cancelCurrentRound(roomId: string, hostPlayerId: string) {
  assertD1Env();

  const { data: room, error } = await d1
    .from("rooms")
    .update({
      current_presenter_player_id: null,
      current_game_id: null,
      prepared_question_set_id: null,
      game_status: "LOBBY",
    })
    .eq("id", roomId)
    .eq("host_player_id", hostPlayerId)
    .select()
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  if (!room) {
    throw new Error("取消本轮失败：只有房主可以取消当前出题流程。");
  }

  return toRoom(room);
}

export async function cancelPresenterSetup(roomId: string, presenterPlayerId: string) {
  assertD1Env();

  const { data: room, error } = await d1
    .from("rooms")
    .update({
      current_presenter_player_id: null,
      current_game_id: null,
      prepared_question_set_id: null,
      game_status: "LOBBY",
    })
    .eq("id", roomId)
    .eq("current_presenter_player_id", presenterPlayerId)
    .eq("game_status", "QUESTION_SETUP")
    .select()
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  if (!room) {
    throw new Error("撤回出题人失败：只有当前出题人可以在准备阶段撤回。");
  }

  return toRoom(room);
}

export async function createUploadedQuestionSet(params: {
  roomId: string;
  presenterPlayerId: string;
  title: string;
  description?: string;
  imageUrls?: string[];
  questions?: QuestionImportItem[];
}) {
  assertD1Env();

  const title = params.title.trim();
  const questionItems = normalizeQuestionImportItems(
    params.questions ?? params.imageUrls?.map((imageUrl) => ({ imageUrl })) ?? [],
  );
  const imageUrls = questionItems.map((item) => item.imageUrl);

  if (!title) {
    throw new Error("请先输入题库标题。");
  }

  if (imageUrls.length === 0) {
    throw new Error("没有检测到有效图片链接，请至少提供一张 http/https 图片。");
  }

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", params.roomId)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("game_status", "QUESTION_SETUP")
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    throw new Error("创建题库失败：当前房间不在出题阶段，或你不是本轮出题人。");
  }

  const createdByNickname = await getPlayerNickname(params.presenterPlayerId, params.roomId);

  const { data: questionSet, error: questionSetError } = await d1
    .from("question_sets")
    .insert({
      title,
      description: params.description?.trim() || null,
      created_by_player_id: params.presenterPlayerId,
      created_by_nickname: createdByNickname,
      source: "uploaded",
      is_public: false,
      image_count: imageUrls.length,
      image_urls_text: imageUrlsToText(imageUrls),
    })
    .select()
    .single<DbQuestionSet>();

  if (questionSetError) {
    throw new Error(questionSetError.message);
  }

  const { data: questions, error: questionsError } = await d1
    .from("questions")
    .insert(
      imageUrls.map((imageUrl, index) => {
        const labelText = questionItems[index].labelText;

        return {
          question_set_id: questionSet.id,
          image_url: imageUrl,
          order_index: index,
          label_text: labelText,
          label_source: labelText ? "manual" : null,
          label_updated_by_player_id: labelText ? params.presenterPlayerId : null,
          label_updated_at: labelText ? new Date().toISOString() : null,
        };
      }),
    )
    .select()
    .order("order_index", { ascending: true })
    .returns<DbQuestion[]>();

  if (questionsError) {
    throw new Error(questionsError.message);
  }

  return toQuestionSet(questionSet, questions ?? []);
}

export async function assertCanCreateUploadedQuestionSet(params: { roomId: string; presenterPlayerId: string }) {
  assertD1Env();

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", params.roomId)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("game_status", "QUESTION_SETUP")
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    throw new Error("创建题库失败：当前房间不在出题阶段，或你不是本轮出题人。");
  }
}

export async function createQuestionSetFromUrlText(params: {
  roomId: string;
  presenterPlayerId: string;
  title: string;
  description?: string;
  imageUrlsText: string;
}) {
  const questions = parseQuestionImportText(params.imageUrlsText);

  if (questions.length === 0) {
    throw new Error("没有检测到有效图片链接。请使用 http/https 图片链接，或每行一个包含 image_url 的 JSON 对象。");
  }

  return createUploadedQuestionSet({
    roomId: params.roomId,
    presenterPlayerId: params.presenterPlayerId,
    title: params.title,
    description: params.description,
    questions,
  });
}

export async function getQuestionSetById(questionSetId: string) {
  assertD1Env();

  const { data: questionSet, error } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", questionSetId)
    .maybeSingle<DbQuestionSet>();

  if (error) {
    throw new Error(error.message);
  }

  if (!questionSet) {
    return null;
  }

  const questions = await getDbQuestionsByQuestionSetId(questionSet.id);
  return toQuestionSet(questionSet, questions);
}

export async function getCommunityQuestionSets(sort: "latest" | "rating" = "latest") {
  assertD1Env();

  let query = d1.from("question_sets").select("*").eq("is_public", true);

  if (sort === "rating") {
    query = query.order("rating_avg", { ascending: false }).order("rating_count", { ascending: false });
  } else {
    query = query.order("created_at", { ascending: false });
  }

  const { data, error } = await query.limit(30).returns<DbQuestionSet[]>();

  if (error) {
    throw new Error(error.message);
  }

  const questionSets = await Promise.all(
    (data ?? []).map(async (questionSet) => {
      const questions = await getDbQuestionsByQuestionSetId(questionSet.id);
      return toQuestionSet(questionSet, questions);
    }),
  );

  return questionSets;
}

export async function prepareQuestionSetForStart(params: {
  roomId: string;
  presenterPlayerId: string;
  questionSetId: string;
}) {
  assertD1Env();

  const { data: questionSet, error: questionSetError } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", params.questionSetId)
    .maybeSingle<DbQuestionSet>();

  if (questionSetError) {
    throw new Error(questionSetError.message);
  }

  if (!questionSet || questionSet.image_count <= 0) {
    throw new Error("题库不存在，或题库中没有图片。");
  }

  if (questionSet.created_by_player_id !== params.presenterPlayerId && !questionSet.is_public) {
    throw new Error("不能使用他人的未公开题库。");
  }

  const { data: room, error } = await d1
    .from("rooms")
    .update({
      prepared_question_set_id: params.questionSetId,
    })
    .eq("id", params.roomId)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("game_status", "QUESTION_SETUP")
    .select()
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  if (!room) {
    throw new Error("准备题库失败：当前房间不在出题阶段，或你不是本轮出题人。");
  }

  return toRoom(room);
}

export async function startGameWithQuestionSet(params: {
  roomId: string;
  hostPlayerId: string;
  presenterPlayerId: string;
  questionSetId: string;
  gameMode?: GameMode;
  maxRevealRounds?: number;
  roundSeconds?: number;
  roundScores?: number[];
}) {
  assertD1Env();

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", params.roomId)
    .eq("host_player_id", params.hostPlayerId)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("prepared_question_set_id", params.questionSetId)
    .eq("game_status", "QUESTION_SETUP")
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    throw new Error("开始游戏失败：只有房主可以使用已准备好的题库开始游戏。");
  }

  const { data: questionSet, error: questionSetError } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", params.questionSetId)
    .maybeSingle<DbQuestionSet>();

  if (questionSetError) {
    throw new Error(questionSetError.message);
  }

  if (!questionSet || questionSet.image_count <= 0) {
    throw new Error("开始游戏失败：题库不存在，或题库中没有图片。");
  }

  if (questionSet.created_by_player_id !== params.presenterPlayerId && !questionSet.is_public) {
    throw new Error("开始游戏失败：不能使用他人的未公开题库。");
  }

  const maxRevealRounds = Math.max(1, Math.min(10, Math.floor(params.maxRevealRounds ?? 3)));
  const roundSeconds = Math.max(1, Math.min(600, Math.floor(params.roundSeconds ?? 60)));
  const gameMode = params.gameMode ?? "ROUND_REVEAL";
  const { data: players, error: playersError } = await d1
    .from("players")
    .select("*")
    .eq("room_id", params.roomId)
    .order("joined_at", { ascending: true })
    .returns<DbPlayer[]>();

  if (playersError) {
    throw new Error(playersError.message);
  }

  const activeGamePlayers = (players ?? []).filter(isGamePlayer);
  const presenter = activeGamePlayers.find((player) => player.id === params.presenterPlayerId);
  if (!presenter) {
    throw new Error("开始游戏失败：出题人必须是玩家身份。");
  }

  const teamBattleGuessers = activeGamePlayers.filter((player) => player.id !== params.presenterPlayerId);
  if (gameMode === "TEAM_BATTLE" && teamBattleGuessers.length < 2) {
    throw new Error("红蓝对抗模式至少需要 2 名答题者。");
  }

  const teamBattleState = gameMode === "TEAM_BATTLE" ? createInitialTeamBattleState(activeGamePlayers, params.presenterPlayerId) : null;
  const roundScores = Array.from({ length: maxRevealRounds }, (_, index) => {
    const score = params.roundScores?.[index] ?? Math.max(1, maxRevealRounds - index);
    return Math.max(0, Math.floor(score));
  });

  const { data: gameSession, error: gameSessionError } = await d1
    .from("game_sessions")
    .insert({
      room_id: params.roomId,
      question_set_id: params.questionSetId,
      presenter_player_id: params.presenterPlayerId,
      status: "PLAYING",
      game_mode: gameMode,
      max_reveal_rounds: maxRevealRounds,
      round_seconds: roundSeconds,
      round_scores: roundScores,
      team_battle_state: teamBattleState,
    })
    .select()
    .single<DbGameSession>();

  if (gameSessionError) {
    throw new Error(gameSessionError.message);
  }

  const eligiblePlayerIds = await createQuestionEligibilitySnapshotFromPlayers({
    gameSessionId: gameSession.id,
    questionIndex: gameSession.current_question_index,
    presenterPlayerId: params.presenterPlayerId,
    players: activeGamePlayers,
  });
  const hydratedGameSession = {
    ...toGameSession(gameSession),
    eligiblePlayerIds,
  };

  const { data: updatedRoom, error: updateRoomError } = await d1
    .from("rooms")
    .update({
      current_game_id: gameSession.id,
      prepared_question_set_id: null,
      game_status: "PLAYING",
    })
    .eq("id", params.roomId)
    .eq("host_player_id", params.hostPlayerId)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("prepared_question_set_id", params.questionSetId)
    .eq("game_status", "QUESTION_SETUP")
    .select()
    .maybeSingle<DbRoom>();

  if (updateRoomError) {
    throw new Error(updateRoomError.message);
  }

  if (!updatedRoom) {
    await d1
      .from("game_sessions")
      .update({
        status: "GAME_RESULT",
        ended_at: new Date().toISOString(),
      })
      .eq("id", gameSession.id);
    throw new Error("开始游戏失败：房间状态已变化，请刷新后重试。");
  }

  return {
    gameSession: hydratedGameSession,
    room: toRoom(updatedRoom),
  };
}

export async function updatePlayerRole(roomId: string, actorPlayerId: string, targetPlayerId: string, role: PlayerRole) {
  assertD1Env();

  if (!isPlayerRole(role)) {
    throw new Error("身份切换失败：未知的玩家身份。");
  }

  if (actorPlayerId !== targetPlayerId) {
    throw new Error("身份切换失败：只能切换自己的玩家/观战身份。");
  }

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    throw new Error("身份切换失败：房间不存在。");
  }

  const canSwitchRole = room.game_status === "LOBBY" || room.game_status === "QUESTION_SETUP";
  if (!canSwitchRole) {
    throw new Error("只有在房间大厅或出题准备阶段可以切换玩家/观战身份。");
  }

  if (room.game_status === "QUESTION_SETUP" && role === "SPECTATOR" && targetPlayerId === room.current_presenter_player_id) {
    throw new Error("当前出题人不能切换为观战身份。");
  }

  const players = await getDbPlayersByRoomId(roomId);
  const targetPlayer = players.find((player) => player.id === targetPlayerId);

  if (!targetPlayer) {
    throw new Error("身份切换失败：你不在当前房间。");
  }

  if (role === "PLAYER" && !isGamePlayer(targetPlayer) && countGamePlayers(players) >= MAX_PLAYERS_PER_ROOM) {
    throw new Error(`玩家已满，最多支持 ${MAX_PLAYERS_PER_ROOM} 名玩家；可以继续观战。`);
  }

  const { data: updatedPlayer, error: updateError } = await d1
    .from("players")
    .update({
      role,
      last_seen_at: new Date().toISOString(),
    })
    .eq("room_id", roomId)
    .eq("id", targetPlayerId)
    .select()
    .maybeSingle<DbPlayer>();

  if (updateError) {
    throw new Error(updateError.message);
  }

  if (!updatedPlayer) {
    throw new Error("身份切换失败：你不在当前房间。");
  }

  const nextPlayers = await getDbPlayersByRoomId(roomId);
  return toRoom(room, nextPlayers);
}

export async function getGameSessionById(gameSessionId: string) {
  assertD1Env();

  const { data, error } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", gameSessionId)
    .maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  return data ? await hydrateGameSessionEligibility(toGameSession(data)) : null;
}

async function getDbQuestionsByQuestionSetId(questionSetId: string) {
  assertD1Env();

  const { data, error } = await d1
    .from("questions")
    .select("*")
    .eq("question_set_id", questionSetId)
    .order("order_index", { ascending: true })
    .returns<DbQuestion[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function getQuestionsByQuestionSetId(questionSetId: string) {
  const questions = await getDbQuestionsByQuestionSetId(questionSetId);
  return questions.map(toQuestion);
}

export async function confirmRevealBlocks(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  selectedBlocks: number[];
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("打开方块失败：当前游戏不存在，或你不是出题人。");
  }

  const roundStartedAt = currentGameSession.round_started_at;
  if (roundStartedAt) {
    throw new Error("本轮尚未结算，请先判定答案或点击进入下一轮。");
  }

  const allGuessersCorrect = await areAllGuessersCorrectForQuestion({
    roomId: currentGameSession.room_id,
    gameSessionId: currentGameSession.id,
    questionIndex: currentGameSession.current_question_index,
    presenterPlayerId: currentGameSession.presenter_player_id,
  });

  if (allGuessersCorrect) {
    return revealQuestionForReview(currentGameSession.id);
  }

  const revealedBlocks = toGameSession(currentGameSession).revealedBlocks;
  const selectedBlocks = params.selectedBlocks.filter(
    (block) => Number.isInteger(block) && block >= 0 && block < REVEAL_BLOCK_COUNT,
  );
  const nextBlocks = Array.from(new Set([...revealedBlocks, ...selectedBlocks])).sort((a, b) => a - b);

  if (nextBlocks.length === revealedBlocks.length) {
    throw new Error("请至少选择一个尚未打开的方块。");
  }

  const { data: updatedGameSession, error } = await d1
    .from("game_sessions")
    .update({
      revealed_blocks: nextBlocks,
      round_started_at: new Date().toISOString(),
    })
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .select()
    .maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!updatedGameSession) {
    throw new Error("打开方块失败：游戏状态已变化，请刷新后重试。");
  }

  return toGameSession(updatedGameSession);
}

export async function getAnswersForQuestionRound(params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .eq("reveal_round", params.revealRound)
    .order("submitted_at", { ascending: true })
    .returns<DbAnswer[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toAnswer);
}

export async function getAnswersForQuestion(params: {
  gameSessionId: string;
  questionIndex: number;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .order("submitted_at", { ascending: true })
    .returns<DbAnswer[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toAnswer);
}

export async function getAnswerForPlayerRound(params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
  playerId: string;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .eq("reveal_round", params.revealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  return data ? toAnswer(data) : null;
}

export async function getBuzzerAnswersForQuestionRound(params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("buzzer_answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .eq("reveal_round", params.revealRound)
    .order("submitted_at", { ascending: true })
    .returns<DbBuzzerAnswer[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toBuzzerAnswer);
}

export async function getBuzzerAnswersForQuestion(params: {
  gameSessionId: string;
  questionIndex: number;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("buzzer_answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .order("submitted_at", { ascending: true })
    .returns<DbBuzzerAnswer[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toBuzzerAnswer);
}

export async function getBuzzerAnswerForPlayerRound(params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
  playerId: string;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("buzzer_answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .eq("reveal_round", params.revealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbBuzzerAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  return data ? toBuzzerAnswer(data) : null;
}

export async function getRoundSnapshot(gameSessionId: string): Promise<RoundSnapshot> {
  assertD1Env();

  const gameSession = await getGameSessionById(gameSessionId);

  if (!gameSession) {
    throw new Error("刷新游戏快照失败：当前游戏不存在。");
  }

  const questionIndex = gameSession.currentQuestionIndex;
  const revealRound = gameSession.currentRevealRound;
  const [
    { data: scores, error: scoresError },
    { data: questionResults, error: questionResultsError },
    { data: currentRoundAnswers, error: currentRoundAnswersError },
    { data: questionAnswers, error: questionAnswersError },
    { data: currentRoundBuzzerAnswers, error: currentRoundBuzzerAnswersError },
    { data: questionBuzzerAnswers, error: questionBuzzerAnswersError },
    { data: roomPlayers, error: roomPlayersError },
  ] = await Promise.all([
    d1
      .from("player_scores")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .order("score", { ascending: false })
      .returns<DbPlayerScore[]>(),
    d1
      .from("question_results")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", questionIndex)
      .returns<DbQuestionResult[]>(),
    d1
      .from("answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", questionIndex)
      .eq("reveal_round", revealRound)
      .order("submitted_at", { ascending: true })
      .returns<DbAnswer[]>(),
    d1
      .from("answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", questionIndex)
      .order("submitted_at", { ascending: true })
      .returns<DbAnswer[]>(),
    d1
      .from("buzzer_answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", questionIndex)
      .eq("reveal_round", revealRound)
      .order("submitted_at", { ascending: true })
      .returns<DbBuzzerAnswer[]>(),
    d1
      .from("buzzer_answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", questionIndex)
      .order("submitted_at", { ascending: true })
      .returns<DbBuzzerAnswer[]>(),
    d1
      .from("players")
      .select("*")
      .eq("room_id", gameSession.roomId)
      .returns<DbPlayer[]>(),
  ]);

  if (scoresError) {
    throw new Error(scoresError.message);
  }
  if (questionResultsError) {
    throw new Error(questionResultsError.message);
  }
  if (currentRoundAnswersError) {
    throw new Error(currentRoundAnswersError.message);
  }
  if (questionAnswersError) {
    throw new Error(questionAnswersError.message);
  }
  if (currentRoundBuzzerAnswersError) {
    throw new Error(currentRoundBuzzerAnswersError.message);
  }
  if (questionBuzzerAnswersError) {
    throw new Error(questionBuzzerAnswersError.message);
  }
  if (roomPlayersError) {
    throw new Error(roomPlayersError.message);
  }

  const activeRoomGamePlayerSet = new Set((roomPlayers ?? []).filter(isGamePlayer).map((player) => player.id));
  const activeEligiblePlayerSet = new Set(
    (gameSession.eligiblePlayerIds ?? []).filter((playerId) => activeRoomGamePlayerSet.has(playerId)),
  );
  const activeCurrentRoundAnswers = (currentRoundAnswers ?? []).filter((answer) => activeEligiblePlayerSet.has(answer.player_id));
  const activeCurrentRoundBuzzerAnswers = (currentRoundBuzzerAnswers ?? []).filter((answer) =>
    activeEligiblePlayerSet.has(answer.player_id),
  );
  const correctQuestionResults = questionResults ?? [];

  return {
    gameSession,
    scores: (scores ?? []).map(toPlayerScore),
    questionResults: (questionResults ?? []).map(toQuestionResult),
    answers: activeCurrentRoundAnswers.map(toAnswer),
    labelAnswers: getCorrectAnswersForLabel(questionAnswers ?? [], correctQuestionResults).map(toAnswer),
    buzzerAnswers: activeCurrentRoundBuzzerAnswers.map(toBuzzerAnswer),
    labelBuzzerAnswers: getCorrectAnswersForLabel(
      (questionBuzzerAnswers ?? []).filter((answer) => answer.status === "correct"),
      correctQuestionResults,
    ).map(toBuzzerAnswer),
  };
}

export async function getGameBootstrapSnapshot(gameSessionId: string): Promise<GameBootstrapSnapshot> {
  assertD1Env();

  const gameSession = await getGameSessionById(gameSessionId);

  if (!gameSession) {
    throw new Error("加载游戏快照失败：当前游戏不存在。");
  }

  const [questions, roundSnapshot] = await Promise.all([
    getQuestionsByQuestionSetId(gameSession.questionSetId),
    getRoundSnapshot(gameSession.id),
  ]);

  return {
    gameSession,
    questions,
    roundSnapshot,
  };
}

export async function getPlayerScores(gameSessionId: string) {
  assertD1Env();

  const { data, error } = await d1
    .from("player_scores")
    .select("*")
    .eq("game_session_id", gameSessionId)
    .order("score", { ascending: false })
    .returns<DbPlayerScore[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toPlayerScore);
}

export async function getLeaderboardForGameSession(gameSessionId: string): Promise<LeaderboardEntry[]> {
  assertD1Env();

  const gameSession = await getGameSessionById(gameSessionId);

  if (!gameSession) {
    throw new Error("排行榜加载失败：游戏不存在。");
  }

  const [{ data: players, error: playersError }, scores] = await Promise.all([
    d1
      .from("players")
      .select("*")
      .eq("room_id", gameSession.roomId)
      .returns<DbPlayer[]>(),
    getPlayerScores(gameSessionId),
  ]);

  if (playersError) {
    throw new Error(playersError.message);
  }

  const scoreByPlayerId = new Map(scores.map((score) => [score.playerId, score]));

  return (players ?? [])
    .filter((player) => isGamePlayer(player) && player.id !== gameSession.presenterPlayerId)
    .map((player) => {
      const score = scoreByPlayerId.get(player.id);

      return {
        playerId: player.id,
        nickname: player.nickname,
        rank: 0,
        score: score?.score ?? 0,
        correctCount: score?.correctCount ?? 0,
      };
    })
    .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount || a.nickname.localeCompare(b.nickname))
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));
}

export async function publishQuestionSetToCommunity(params: {
  questionSetId: string;
  playerId: string;
  title: string;
  description?: string;
}) {
  assertD1Env();

  const title = params.title.trim();

  if (!title) {
    throw new Error("发布社区题库前，请先输入题库标题。");
  }

  const createdByNickname = await getPlayerNickname(params.playerId);

  const { data: questionSet, error } = await d1
    .from("question_sets")
    .update({
      title,
      description: params.description?.trim() || null,
      created_by_nickname: createdByNickname ?? undefined,
      is_public: true,
    })
    .eq("id", params.questionSetId)
    .eq("created_by_player_id", params.playerId)
    .select()
    .maybeSingle<DbQuestionSet>();

  if (error) {
    throw new Error(error.message);
  }

  if (!questionSet) {
    throw new Error("发布失败：题库不存在，或你不是题库创建者。");
  }

  const questions = await getDbQuestionsByQuestionSetId(questionSet.id);
  return toQuestionSet(questionSet, questions);
}

export async function rateCommunityQuestionSet(params: {
  questionSetId: string;
  playerId: string;
  rating: number;
  roomId: string;
}) {
  assertD1Env();

  const rating = Math.max(1, Math.min(5, Math.floor(params.rating)));

  if (!params.roomId) {
    throw new Error("评分失败：缺少房间信息。");
  }

  await assertGamePlayerInRoom(params.roomId, params.playerId);

  const { data: questionSet, error: questionSetError } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", params.questionSetId)
    .eq("is_public", true)
    .maybeSingle<DbQuestionSet>();

  if (questionSetError) {
    throw new Error(questionSetError.message);
  }

  if (!questionSet) {
    throw new Error("评分失败：该社区题库不存在或尚未公开。");
  }

  const { error: ratingError } = await d1.from("question_set_ratings").upsert(
    {
      question_set_id: params.questionSetId,
      player_id: params.playerId,
      rating,
    },
    { onConflict: "question_set_id,player_id" },
  );

  if (ratingError) {
    throw new Error(ratingError.message);
  }

  const { data: ratings, error: ratingsLoadError } = await d1
    .from("question_set_ratings")
    .select("rating")
    .eq("question_set_id", params.questionSetId)
    .returns<{ rating: number }[]>();

  if (ratingsLoadError) {
    throw new Error(ratingsLoadError.message);
  }

  const ratingCount = ratings?.length ?? 0;
  const ratingAvg =
    ratingCount > 0
      ? Math.round((ratings ?? []).reduce((total, item) => total + item.rating, 0) * 100 / ratingCount) / 100
      : 0;

  const { data: updatedQuestionSet, error: updateError } = await d1
    .from("question_sets")
    .update({
      rating_avg: ratingAvg,
      rating_count: ratingCount,
    })
    .eq("id", params.questionSetId)
    .select()
    .single<DbQuestionSet>();

  if (updateError) {
    throw new Error(updateError.message);
  }

  const questions = await getDbQuestionsByQuestionSetId(updatedQuestionSet.id);
  return toQuestionSet(updatedQuestionSet, questions);
}

export async function getQuestionSetRatingProgress(params: {
  questionSetId: string;
  playerIds: string[];
  playerId?: string;
}) {
  assertD1Env();

  const playerIds = Array.from(new Set(params.playerIds.filter((id) => typeof id === "string" && id.trim())));

  if (playerIds.length === 0) {
    return {
      ratedCount: 0,
      totalCount: 0,
      ratedPlayerIds: [],
      playerRating: null,
    };
  }

  const { data: ratings, error } = await d1
    .from("question_set_ratings")
    .select("player_id,rating")
    .eq("question_set_id", params.questionSetId)
    .returns<{ player_id: string; rating: number }[]>();

  if (error) {
    throw new Error(error.message);
  }

  const playerIdSet = new Set(playerIds);
  const roomRatings = (ratings ?? []).filter((rating) => playerIdSet.has(rating.player_id));
  const ratedPlayerIds = roomRatings.map((rating) => rating.player_id);
  const playerRating = roomRatings.find((rating) => rating.player_id === params.playerId)?.rating ?? null;

  return {
    ratedCount: ratedPlayerIds.length,
    totalCount: playerIds.length,
    ratedPlayerIds,
    playerRating,
  };
}

export async function getQuestionResultsForQuestion(params: {
  gameSessionId: string;
  questionIndex: number;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("question_results")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .returns<DbQuestionResult[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toQuestionResult);
}

export async function getQuestionResultsForGameSession(gameSessionId: string) {
  assertD1Env();

  const { data, error } = await d1
    .from("question_results")
    .select("*")
    .eq("game_session_id", gameSessionId)
    .returns<DbQuestionResult[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toQuestionResult);
}

async function adjustPlayerScore(params: {
  gameSessionId: string;
  playerId: string;
  scoreDelta: number;
  correctCountDelta?: number;
}) {
  const correctCountDelta = params.correctCountDelta ?? 0;

  if (params.scoreDelta === 0 && correctCountDelta === 0) {
    return;
  }

  const { data: existingScore, error: scoreLoadError } = await d1
    .from("player_scores")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("player_id", params.playerId)
    .maybeSingle<DbPlayerScore>();

  if (scoreLoadError) {
    throw new Error(scoreLoadError.message);
  }

  const { error: scoreError } = await d1.from("player_scores").upsert(
    {
      id: existingScore?.id,
      game_session_id: params.gameSessionId,
      player_id: params.playerId,
      score: Math.max(0, (existingScore?.score ?? 0) + params.scoreDelta),
      correct_count: Math.max(0, (existingScore?.correct_count ?? 0) + correctCountDelta),
    },
    {
      onConflict: "game_session_id,player_id",
    },
  );

  if (scoreError) {
    throw new Error(scoreError.message);
  }
}

async function addScoreToPlayer(params: {
  gameSessionId: string;
  playerId: string;
  scoreAwarded: number;
}) {
  await adjustPlayerScore({
    gameSessionId: params.gameSessionId,
    playerId: params.playerId,
    scoreDelta: params.scoreAwarded,
    correctCountDelta: 1,
  });
}

async function recalculateRankedBuzzerScores(params: {
  gameSession: DbGameSession;
}) {
  const [guesserIds, { data: results, error: resultsError }, { data: correctBuzzerAnswers, error: answersError }] =
    await Promise.all([
      getOrCreateQuestionEligiblePlayerIds({
        gameSessionId: params.gameSession.id,
        roomId: params.gameSession.room_id,
        questionIndex: params.gameSession.current_question_index,
        presenterPlayerId: params.gameSession.presenter_player_id,
      }),
      d1
        .from("question_results")
        .select("*")
        .eq("game_session_id", params.gameSession.id)
        .eq("question_index", params.gameSession.current_question_index)
        .returns<DbQuestionResult[]>(),
      d1
        .from("buzzer_answers")
        .select("*")
        .eq("game_session_id", params.gameSession.id)
        .eq("question_index", params.gameSession.current_question_index)
        .eq("status", "correct")
        .returns<DbBuzzerAnswer[]>(),
    ]);

  if (resultsError) {
    throw new Error(resultsError.message);
  }

  if (answersError) {
    throw new Error(answersError.message);
  }

  const guesserCount = guesserIds.length;
  const answerByPlayerId = new Map((correctBuzzerAnswers ?? []).map((answer) => [answer.player_id, answer]));
  const rankedResults = (results ?? [])
    .map((result) => ({ result, answer: answerByPlayerId.get(result.player_id) }))
    .filter((item): item is { result: DbQuestionResult; answer: DbBuzzerAnswer } => Boolean(item.answer))
    .sort(
      (a, b) =>
        new Date(a.answer.submitted_at).getTime() - new Date(b.answer.submitted_at).getTime() ||
        new Date(a.result.judged_at).getTime() - new Date(b.result.judged_at).getTime() ||
        a.result.id.localeCompare(b.result.id),
    );
  const scoreByPlayerId = new Map<string, number>();

  for (const [index, item] of rankedResults.entries()) {
    const nextScoreAwarded = Math.max(1, guesserCount - index);
    scoreByPlayerId.set(item.result.player_id, nextScoreAwarded);

    if (item.result.score_awarded !== nextScoreAwarded) {
      await adjustPlayerScore({
        gameSessionId: params.gameSession.id,
        playerId: item.result.player_id,
        scoreDelta: nextScoreAwarded - item.result.score_awarded,
      });

      const { error: resultUpdateError } = await d1
        .from("question_results")
        .update({ score_awarded: nextScoreAwarded })
        .eq("id", item.result.id);

      if (resultUpdateError) {
        throw new Error(resultUpdateError.message);
      }
    }

    if (item.answer.score_awarded !== nextScoreAwarded) {
      const { error: answerUpdateError } = await d1
        .from("buzzer_answers")
        .update({ score_awarded: nextScoreAwarded })
        .eq("id", item.answer.id);

      if (answerUpdateError) {
        throw new Error(answerUpdateError.message);
      }
    }
  }

  return scoreByPlayerId;
}

async function updatePendingBuzzerAnswer(params: {
  id: string;
  answerText: string;
}) {
  const { data, error } = await d1
    .from("buzzer_answers")
    .update({
      answer_text: params.answerText,
      status: "pending",
      score_awarded: 0,
      submitted_at: new Date().toISOString(),
      judged_at: null,
      judged_by_player_id: null,
    })
    .eq("id", params.id)
    .eq("status", "pending")
    .select()
    .maybeSingle<DbBuzzerAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("更新答案失败：该答案已经被判定，不能再修改。");
  }
}

async function writePendingRoundRevealBuzzerAnswer(params: {
  gameSession: GameSession;
  playerId: string;
  answerText: string;
  existingBuzzerAnswer: DbBuzzerAnswer | null;
}) {
  if (params.existingBuzzerAnswer) {
    if (params.existingBuzzerAnswer.status !== "pending") {
      throw new Error("该抢答已经被判定，不能再修改。");
    }

    await updatePendingBuzzerAnswer({
      id: params.existingBuzzerAnswer.id,
      answerText: params.answerText,
    });
    return;
  }

  const { error } = await d1.from("buzzer_answers").insert({
    game_session_id: params.gameSession.id,
    question_index: params.gameSession.currentQuestionIndex,
    reveal_round: params.gameSession.currentRevealRound,
    player_id: params.playerId,
    answer_text: params.answerText,
    status: "pending",
    score_awarded: 0,
    submitted_at: new Date().toISOString(),
    judged_at: null,
    judged_by_player_id: null,
  });

  if (!error) {
    return;
  }

  if (!isUniqueViolation(error)) {
    throw new Error(error.message);
  }

  const { data: currentBuzzerAnswer, error: currentError } = await d1
    .from("buzzer_answers")
    .select("*")
    .eq("game_session_id", params.gameSession.id)
    .eq("question_index", params.gameSession.currentQuestionIndex)
    .eq("reveal_round", params.gameSession.currentRevealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbBuzzerAnswer>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentBuzzerAnswer || currentBuzzerAnswer.status !== "pending") {
    throw new Error("提交失败：该抢答已经被判定，不能再修改。");
  }

  await updatePendingBuzzerAnswer({
    id: currentBuzzerAnswer.id,
    answerText: params.answerText,
  });
}

async function revealQuestionForReview(gameSessionId: string) {
  const { data: reviewedGameSession, error } = await d1
    .from("game_sessions")
    .update({
      revealed_blocks: ALL_REVEALED_BLOCKS,
      round_started_at: null,
    })
    .eq("id", gameSessionId)
    .select()
    .single<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  return toGameSession(reviewedGameSession);
}

async function forfeitMissingRoundActions(
  currentGameSession: DbGameSession,
  currentSession: GameSession,
  roundActionState?: Awaited<ReturnType<typeof getRoundActionState>>,
) {
  const resolvedRoundActionState = roundActionState ?? await getRoundActionState(currentSession);
  const now = new Date().toISOString();
  const missingGuesserIds = resolvedRoundActionState.eligibleGuesserIds.filter(
    (guesserId) => !resolvedRoundActionState.hasPlayerActed(guesserId),
  );

  for (const guesserId of missingGuesserIds) {
    const { error } = await d1.from("answers").upsert(
      {
        game_session_id: currentGameSession.id,
        question_index: currentGameSession.current_question_index,
        reveal_round: currentGameSession.current_reveal_round,
        player_id: guesserId,
        answer_text: FORFEIT_ANSWER_TEXT,
        submitted_at: now,
      },
      {
        onConflict: "game_session_id,question_index,reveal_round,player_id",
      },
    );

    if (error) {
      throw new Error(error.message);
    }
  }

  return missingGuesserIds.length;
}

async function settleRevealRoundForNextSelection(currentGameSession: DbGameSession) {
  const maxRevealRounds = currentGameSession.max_reveal_rounds ?? 3;

  const { data: updatedGameSession, error } = await d1
    .from("game_sessions")
    .update({
      current_reveal_round: Math.min(maxRevealRounds, currentGameSession.current_reveal_round + 1),
      round_started_at: null,
    })
    .eq("id", currentGameSession.id)
    .select()
    .single<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  return toGameSession(updatedGameSession);
}

async function settleBuzzerRoundFromDb(currentGameSession: DbGameSession) {
  const currentSession = toGameSession(currentGameSession);
  const currentRound = currentGameSession.current_reveal_round;
  const roundStartedAt = currentGameSession.round_started_at;
  const roundEnded = Boolean(
    roundStartedAt && Date.now() - new Date(roundStartedAt).getTime() >= currentSession.roundSeconds * 1000,
  );

  let roundActionState = await getRoundActionState(currentSession);

  if (roundEnded) {
    if (await forfeitMissingRoundActions(currentGameSession, currentSession, roundActionState)) {
      roundActionState = await getRoundActionState(currentSession);
    }
  }

  const hasCorrectAnswer = roundActionState.correctSet.size > 0;
  const allPlayersCorrect =
    roundActionState.guesserIds.length > 0 &&
    roundActionState.guesserIds.every((guesserId) => roundActionState.correctSet.has(guesserId));

  if (allPlayersCorrect || (currentSession.gameMode === "BUZZER_FIRST_CORRECT" && hasCorrectAnswer)) {
    return revealQuestionForReview(currentGameSession.id);
  }

  if (roundActionState.hasPendingAnswers) {
    return currentSession;
  }

  const canSettleBecauseAllChancesUsed = roundActionState.allEligiblePlayersUsedChance;

  if (roundEnded || canSettleBecauseAllChancesUsed) {
    if (currentRound >= currentSession.maxRevealRounds) {
      return revealQuestionForReview(currentGameSession.id);
    }

    return settleRevealRoundForNextSelection(currentGameSession);
  }

  return currentSession;
}

export async function autoForfeitExpiredRound(params: {
  gameSessionId: string;
}) {
  assertD1Env();

  const { data: currentGameSession, error } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!currentGameSession) {
    throw new Error("自动放弃失败：当前游戏不存在或已结束。");
  }

  const currentSession = toGameSession(currentGameSession);
  if (!canUseForfeitAnswer(currentSession.gameMode)) {
    return { gameSession: currentSession };
  }

  if (!currentSession.roundStartedAt) {
    return { gameSession: currentSession };
  }

  const roundEnded = Date.now() - new Date(currentSession.roundStartedAt).getTime() >= currentSession.roundSeconds * 1000;
  if (!roundEnded) {
    return { gameSession: currentSession };
  }

  await forfeitMissingRoundActions(currentGameSession, currentSession);

  return { gameSession: currentSession };
}

export async function submitAnswer(params: {
  gameSessionId: string;
  playerId: string;
  answerText: string;
}) {
  assertD1Env();

  const answerText = params.answerText.trim();

  if (!answerText) {
    throw new Error("请先输入答案。");
  }

  const gameSession = await getGameSessionById(params.gameSessionId);

  if (gameSession?.gameMode !== "ROUND_REVEAL") {
    throw new Error("当前模式不能提交普通答案。");
  }

  if (!gameSession || gameSession.status !== "PLAYING") {
    throw new Error("当前游戏未进行中，不能提交答案。");
  }

  if (gameSession.presenterPlayerId === params.playerId) {
    throw new Error("出题人不能提交答案。");
  }

  await assertGamePlayerInRoom(gameSession.roomId, params.playerId);
  await assertPlayerEligibleForCurrentQuestion(gameSession, params.playerId);

  if (!gameSession.roundStartedAt) {
    throw new Error("本轮尚未开始，暂时不能提交答案。");
  }

  if (Date.now() - new Date(gameSession.roundStartedAt).getTime() >= gameSession.roundSeconds * 1000) {
    throw new Error("本轮答题时间已结束，不能再提交答案。");
  }

  const { data: existingResult, error: resultError } = await d1
    .from("question_results")
    .select("id")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("player_id", params.playerId)
    .maybeSingle<{ id: string }>();

  if (resultError) {
    throw new Error(resultError.message);
  }

  if (existingResult) {
    throw new Error("你已答对本题，不能重复提交答案。");
  }

  const roundActionState = await getRoundActionState(gameSession);
  if (roundActionState.allEligiblePlayersUsedChance) {
    throw new Error("本轮所有玩家都已提交，不能再修改答案。");
  }

  const [{ data: existingAnswer, error: answerLoadError }, { data: existingBuzzerAnswer, error: buzzerLoadError }] =
    await Promise.all([
      d1
        .from("answers")
        .select("*")
        .eq("game_session_id", gameSession.id)
        .eq("question_index", gameSession.currentQuestionIndex)
        .eq("reveal_round", gameSession.currentRevealRound)
        .eq("player_id", params.playerId)
        .maybeSingle<DbAnswer>(),
      d1
        .from("buzzer_answers")
        .select("*")
        .eq("game_session_id", gameSession.id)
        .eq("question_index", gameSession.currentQuestionIndex)
        .eq("reveal_round", gameSession.currentRevealRound)
        .eq("player_id", params.playerId)
        .maybeSingle<DbBuzzerAnswer>(),
    ]);

  if (answerLoadError) {
    throw new Error(answerLoadError.message);
  }

  if (buzzerLoadError) {
    throw new Error(buzzerLoadError.message);
  }

  await writePendingRoundRevealBuzzerAnswer({
    gameSession,
    playerId: params.playerId,
    answerText,
    existingBuzzerAnswer,
  });

  const { data, error } = await d1
    .from("answers")
    .upsert(
      {
        id: existingAnswer?.id,
        game_session_id: gameSession.id,
        question_index: gameSession.currentQuestionIndex,
        reveal_round: gameSession.currentRevealRound,
        player_id: params.playerId,
        answer_text: answerText,
        submitted_at: new Date().toISOString(),
      },
      {
        onConflict: "game_session_id,question_index,reveal_round,player_id",
      },
    )
    .select()
    .single<DbAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  return toAnswer(data);
}

export async function submitForfeitAnswer(params: {
  gameSessionId: string;
  playerId: string;
}) {
  assertD1Env();

  const gameSession = await getGameSessionById(params.gameSessionId);

  if (!gameSession || gameSession.status !== "PLAYING" || !canUseForfeitAnswer(gameSession.gameMode)) {
    throw new Error("当前不能放弃作答：游戏未进行中，或当前模式不支持放弃作答。");
  }

  if (gameSession.presenterPlayerId === params.playerId || !gameSession.roundStartedAt) {
    throw new Error("当前不能放弃作答：出题人不能作答，或本轮尚未开始。");
  }

  await assertGamePlayerInRoom(gameSession.roomId, params.playerId);
  await assertPlayerEligibleForCurrentQuestion(gameSession, params.playerId);

  if (Date.now() - new Date(gameSession.roundStartedAt).getTime() >= gameSession.roundSeconds * 1000) {
    throw new Error("本轮答题时间已结束，不能再放弃作答。");
  }

  const roundActionState = await getRoundActionState(gameSession);
  if (roundActionState.allEligiblePlayersUsedChance) {
    throw new Error("本轮所有玩家都已提交，不能再改为放弃作答。");
  }

  const { data: existingResult, error: resultError } = await d1
    .from("question_results")
    .select("id")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("player_id", params.playerId)
    .maybeSingle<{ id: string }>();

  if (resultError) {
    throw new Error(resultError.message);
  }

  if (existingResult) {
    throw new Error("你已答对本题，不能放弃作答。");
  }

  const { data: existingBuzzerAnswer, error: buzzerLoadError } = await d1
    .from("buzzer_answers")
    .select("*")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("reveal_round", gameSession.currentRevealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbBuzzerAnswer>();

  if (buzzerLoadError) {
    throw new Error(buzzerLoadError.message);
  }

  if (existingBuzzerAnswer && existingBuzzerAnswer.status !== "pending") {
    throw new Error("你的抢答已经被判定，不能改为放弃作答。");
  }

  const { data: existingAnswer, error: answerLoadError } = await d1
    .from("answers")
    .select("*")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("reveal_round", gameSession.currentRevealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbAnswer>();

  if (answerLoadError) {
    throw new Error(answerLoadError.message);
  }

  if (existingBuzzerAnswer) {
    const { data: deletedBuzzerAnswer, error: deleteBuzzerError } = await d1
      .from("buzzer_answers")
      .delete()
      .eq("id", existingBuzzerAnswer.id)
      .eq("status", "pending")
      .single<DbBuzzerAnswer>();

    if (deleteBuzzerError) {
      throw new Error(deleteBuzzerError.message);
    }

    if (!deletedBuzzerAnswer) {
      throw new Error("取消抢答失败：该抢答已经被判定。");
    }
  }

  const { data, error } = await d1
    .from("answers")
    .upsert(
      {
        id: existingAnswer?.id,
        game_session_id: gameSession.id,
        question_index: gameSession.currentQuestionIndex,
        reveal_round: gameSession.currentRevealRound,
        player_id: params.playerId,
        answer_text: FORFEIT_ANSWER_TEXT,
        submitted_at: new Date().toISOString(),
      },
      {
        onConflict: "game_session_id,question_index,reveal_round,player_id",
      },
    )
    .select()
    .single<DbAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  return toAnswer(data);
}

export async function cancelForfeitAnswer(params: {
  gameSessionId: string;
  playerId: string;
}) {
  assertD1Env();

  const gameSession = await getGameSessionById(params.gameSessionId);

  if (!gameSession || gameSession.status !== "PLAYING" || !canUseForfeitAnswer(gameSession.gameMode)) {
    throw new Error("当前不能取消放弃：游戏未进行中，或当前模式不支持取消放弃。");
  }

  if (gameSession.presenterPlayerId === params.playerId || !gameSession.roundStartedAt) {
    throw new Error("当前不能取消放弃：出题人不能作答，或本轮尚未开始。");
  }

  await assertGamePlayerInRoom(gameSession.roomId, params.playerId);
  await assertPlayerEligibleForCurrentQuestion(gameSession, params.playerId);

  if (Date.now() - new Date(gameSession.roundStartedAt).getTime() >= gameSession.roundSeconds * 1000) {
    throw new Error("本轮答题时间已结束，不能再取消放弃。");
  }

  const roundActionState = await getRoundActionState(gameSession);
  if (roundActionState.allEligiblePlayersUsedChance) {
    throw new Error("本轮所有玩家都已提交，不能再取消放弃。");
  }

  const { data: existingAnswer, error: answerLoadError } = await d1
    .from("answers")
    .select("*")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("reveal_round", gameSession.currentRevealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbAnswer>();

  if (answerLoadError) {
    throw new Error(answerLoadError.message);
  }

  if (!existingAnswer || !isForfeitAnswer(existingAnswer)) {
    throw new Error("你当前没有放弃作答记录，不能取消。");
  }

  const { data, error } = await d1
    .from("answers")
    .delete()
    .eq("id", existingAnswer.id)
    .single<DbAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  return {
    gameSession,
    canceledAnswerId: data.id,
  };
}

export async function submitBuzzerAnswer(params: {
  gameSessionId: string;
  playerId: string;
  answerText: string;
  clientRoundElapsedMs?: number | null;
}) {
  assertD1Env();

  const answerText = params.answerText.trim();

  if (!answerText) {
    throw new Error("请先输入抢答答案。");
  }

  const gameSession = await getGameSessionById(params.gameSessionId);

  if (!gameSession || gameSession.status !== "PLAYING" || gameSession.gameMode === "ROUND_REVEAL" || gameSession.gameMode === "TEAM_BATTLE") {
    throw new Error("当前模式不能提交抢答答案。");
  }

  if (gameSession.presenterPlayerId === params.playerId) {
    throw new Error("出题人不能提交抢答答案。");
  }

  await assertGamePlayerInRoom(gameSession.roomId, params.playerId);
  await assertPlayerEligibleForCurrentQuestion(gameSession, params.playerId);

  if (!gameSession.roundStartedAt) {
    throw new Error("本轮尚未开始，暂时不能抢答。");
  }

  const roundStartedAtMs = new Date(gameSession.roundStartedAt).getTime();
  const serverRoundElapsedMs = Date.now() - roundStartedAtMs;
  const clientRoundElapsedMs = Number.isFinite(params.clientRoundElapsedMs) ? params.clientRoundElapsedMs : null;
  const canUseClientRoundElapsedMs =
    typeof clientRoundElapsedMs === "number" &&
    clientRoundElapsedMs >= 0 &&
    clientRoundElapsedMs >= serverRoundElapsedMs - BUZZER_CLIENT_TIME_MAX_EARLY_MS;
  const effectiveRoundElapsedMs = canUseClientRoundElapsedMs ? clientRoundElapsedMs : serverRoundElapsedMs;
  const roundDurationMs = gameSession.roundSeconds * 1000;

  if (effectiveRoundElapsedMs >= roundDurationMs) {
    throw new Error("本轮抢答时间已结束，不能再提交。");
  }

  const submittedAt = new Date(roundStartedAtMs + effectiveRoundElapsedMs).toISOString();

  const { data: existingResult, error: resultError } = await d1
    .from("question_results")
    .select("id")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("player_id", params.playerId)
    .maybeSingle<{ id: string }>();

  if (resultError) {
    throw new Error(resultError.message);
  }

  if (existingResult) {
    throw new Error("你已答对本题，不能重复抢答。");
  }

  if (gameSession.gameMode === "BUZZER_FIRST_CORRECT" && await hasCorrectResultForCurrentQuestion(gameSession)) {
    throw new Error("本题已有玩家答对，不能继续抢答。");
  }

  if (canUseForfeitAnswer(gameSession.gameMode)) {
    const { data: existingAnswer, error: answerLoadError } = await d1
      .from("answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", gameSession.currentQuestionIndex)
      .eq("reveal_round", gameSession.currentRevealRound)
      .eq("player_id", params.playerId)
      .maybeSingle<DbAnswer>();

    if (answerLoadError) {
      throw new Error(answerLoadError.message);
    }

    if (existingAnswer && isForfeitAnswer(existingAnswer)) {
      throw new Error("你已放弃本轮，取消放弃后才能抢答。");
    }
  }

  const { data, error } = await d1
    .from("buzzer_answers")
    .insert({
      game_session_id: gameSession.id,
      question_index: gameSession.currentQuestionIndex,
      reveal_round: gameSession.currentRevealRound,
      player_id: params.playerId,
      answer_text: answerText,
      submitted_at: submittedAt,
    })
    .select()
    .single<DbBuzzerAnswer>();

  if (error) {
    if (isUniqueViolation(error)) {
      throw new Error("你本轮已经提交过抢答。");
    }

    throw new Error(error.message);
  }

  return toBuzzerAnswer(data);
}

export async function judgeBuzzerAnswer(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  buzzerAnswerId: string;
  isCorrect: boolean;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("判定抢答失败：当前游戏不存在，或你不是出题人。");
  }

  const currentSession = toGameSession(currentGameSession);

  if (currentSession.gameMode === "TEAM_BATTLE") {
    throw new Error("红蓝对抗模式不能使用普通抢答判定。");
  }

  const eligiblePlayerIds = await getOrCreateQuestionEligiblePlayerIds({
    gameSessionId: currentGameSession.id,
    roomId: currentGameSession.room_id,
    questionIndex: currentGameSession.current_question_index,
    presenterPlayerId: currentGameSession.presenter_player_id,
    knownEligiblePlayerIds: currentSession.eligiblePlayerIds,
  });
  const [{ data: roomPlayers, error: roomPlayersError }, { data: pendingAnswers, error: pendingError }] = await Promise.all([
    d1
      .from("players")
      .select("*")
      .eq("room_id", currentGameSession.room_id)
      .returns<DbPlayer[]>(),
    d1
      .from("buzzer_answers")
      .select("*")
      .eq("game_session_id", currentGameSession.id)
      .eq("question_index", currentGameSession.current_question_index)
      .eq("reveal_round", currentGameSession.current_reveal_round)
      .eq("status", "pending")
      .order("submitted_at", { ascending: true })
      .returns<DbBuzzerAnswer[]>(),
  ]);

  if (roomPlayersError) {
    throw new Error(roomPlayersError.message);
  }
  if (pendingError) {
    throw new Error(pendingError.message);
  }

  const roomPlayerSet = new Set((roomPlayers ?? []).filter(isGamePlayer).map((player) => player.id));
  const activeEligiblePlayerSet = new Set(eligiblePlayerIds.filter((playerId) => roomPlayerSet.has(playerId)));
  const firstPendingAnswer = (pendingAnswers ?? []).find((answer) => activeEligiblePlayerSet.has(answer.player_id)) ?? null;
  if (!firstPendingAnswer || firstPendingAnswer.id !== params.buzzerAnswerId) {
    throw new Error("请先判定最早提交的待判定抢答。");
  }

  if (!isBuzzerAnswerReadyForJudging(firstPendingAnswer)) {
    throw new Error("请稍等片刻，正在等待可能更早提交的抢答到达。");
  }

  let scoreAwarded = 0;
  const judgedAt = new Date().toISOString();

  if (params.isCorrect) {
    if (currentSession.gameMode === "ROUND_REVEAL") {
      scoreAwarded =
        currentSession.roundScores[currentSession.currentRevealRound - 1] ??
        Math.max(1, currentSession.maxRevealRounds - currentSession.currentRevealRound + 1);
    } else if (currentSession.gameMode === "BUZZER_FIRST_CORRECT") {
      if (await hasCorrectResultForCurrentQuestion(currentSession)) {
        throw new Error("本题已有首个答对玩家，不能继续判为答对。");
      }

      scoreAwarded = 1;
    } else {
      const [eligiblePlayerIds, { data: existingResults, error: resultsError }] = await Promise.all([
        getOrCreateQuestionEligiblePlayerIds({
          gameSessionId: currentGameSession.id,
          roomId: currentGameSession.room_id,
          questionIndex: currentGameSession.current_question_index,
          presenterPlayerId: currentGameSession.presenter_player_id,
        }),
        d1
          .from("question_results")
          .select("id")
          .eq("game_session_id", currentGameSession.id)
          .eq("question_index", currentGameSession.current_question_index)
          .returns<{ id: string }[]>(),
      ]);

      if (resultsError) {
        throw new Error(resultsError.message);
      }

      const guesserCount = eligiblePlayerIds.length;
      const correctRank = (existingResults?.length ?? 0) + 1;
      scoreAwarded = Math.max(1, guesserCount - correctRank + 1);
    }

    const { error: resultError } = await d1.from("question_results").insert({
      game_session_id: currentGameSession.id,
      question_index: currentGameSession.current_question_index,
      player_id: firstPendingAnswer.player_id,
      scored_round: currentGameSession.current_reveal_round,
      score_awarded: scoreAwarded,
      judged_by_player_id: params.presenterPlayerId,
    });

    if (resultError && !isUniqueViolation(resultError)) {
      throw new Error(resultError.message);
    }

    if (!resultError) {
      await addScoreToPlayer({
        gameSessionId: currentGameSession.id,
        playerId: firstPendingAnswer.player_id,
        scoreAwarded,
      });
    }
  }

  const { error: updateError } = await d1
    .from("buzzer_answers")
    .update({
      status: params.isCorrect ? "correct" : "wrong",
      score_awarded: scoreAwarded,
      judged_at: judgedAt,
      judged_by_player_id: params.presenterPlayerId,
    })
    .eq("id", firstPendingAnswer.id)
    .eq("status", "pending");

  if (updateError) {
    throw new Error(updateError.message);
  }

  if (params.isCorrect && currentSession.gameMode === "BUZZER_RANKED") {
    const rankedScoreByPlayerId = await recalculateRankedBuzzerScores({
      gameSession: currentGameSession,
    });
    scoreAwarded = rankedScoreByPlayerId.get(firstPendingAnswer.player_id) ?? scoreAwarded;
  }

  const nextGameSession =
    params.isCorrect && currentSession.gameMode === "BUZZER_FIRST_CORRECT"
      ? await revealQuestionForReview(currentGameSession.id)
      : currentSession;

  return {
    gameSession: nextGameSession,
    judgedAnswer: {
      ...toBuzzerAnswer(firstPendingAnswer),
      status: params.isCorrect ? "correct" as const : "wrong" as const,
      scoreAwarded,
      judgedAt,
      judgedByPlayerId: params.presenterPlayerId,
    },
  };
}

export async function settleBuzzerRound(params: {
  gameSessionId: string;
  presenterPlayerId: string;
}) {
  assertD1Env();

  const { data: currentGameSession, error } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!currentGameSession) {
    throw new Error("结算抢答失败：当前游戏不存在，或你不是出题人。");
  }

  const currentSession = toGameSession(currentGameSession);

  if (currentSession.gameMode === "TEAM_BATTLE") {
    throw new Error("红蓝对抗模式不能使用普通抢答结算。");
  }

  const nextGameSession = await settleBuzzerRoundFromDb(currentGameSession);

  return {
    gameSession: nextGameSession,
  };
}

export async function submitTeamBattleRevealVote(params: {
  gameSessionId: string;
  playerId: string;
  selectedBlocks: number[];
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("红蓝对抗投票失败：当前游戏不存在或已结束。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;

  await assertGamePlayerInRoom(session.roomId, params.playerId);

  if (state.phase !== "REVEAL_VOTE" || getPlayerTeam(state, params.playerId) !== state.activeTeam) {
    throw new Error("还没轮到你所在队伍投票，或当前不是选格阶段。");
  }

  const revealedSet = new Set(session.revealedBlocks);
  const availableCount = REVEAL_BLOCK_COUNT - revealedSet.size;
  const requiredCount = Math.min(state.revealLimit, availableCount);
  const selectedBlocks = Array.from(
    new Set(params.selectedBlocks.filter((block) => Number.isInteger(block) && block >= 0 && block < REVEAL_BLOCK_COUNT && !revealedSet.has(block))),
  ).sort((a, b) => a - b);

  if (selectedBlocks.length !== requiredCount) {
    throw new Error("本轮选择的方块数量不正确，请按要求选择尚未打开的方块。");
  }

  const revealVotes = {
    ...state.revealVotes,
    [params.playerId]: selectedBlocks,
  };
  const nextState = withVoteDeadlineIfComplete(
    {
      ...state,
      revealVotes,
      message: `${getTeamName(state.activeTeam)}正在投票选择 ${requiredCount} 个方块。`,
    },
    revealVotes,
  );
  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState);

  if (error) {
    throw new Error(error.message);
  }

  return toGameSession(updatedGameSession);
}

export async function submitTeamBattleGuessVote(params: {
  gameSessionId: string;
  playerId: string;
  vote: TeamBattleGuessVote;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("红蓝对抗猜测投票失败：当前游戏不存在或已结束。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;

  await assertGamePlayerInRoom(session.roomId, params.playerId);

  if (state.phase !== "GUESS_VOTE" || getPlayerTeam(state, params.playerId) !== state.activeTeam) {
    throw new Error("还没轮到你所在队伍投票，或当前不是猜测投票阶段。");
  }

  const vote =
    params.vote.type === "skip"
      ? { type: "skip" as const }
      : {
          type: "guess" as const,
          answerText: params.vote.answerText?.trim() ?? "",
        };

  if (vote.type === "guess" && !vote.answerText) {
    throw new Error("请输入要猜的答案，或选择跳过。");
  }

  const guessVotes = {
    ...state.guessVotes,
    [params.playerId]: vote,
  };
  const nextState = withVoteDeadlineIfComplete(
    {
      ...state,
      guessVotes,
      message: `${getTeamName(state.activeTeam)}正在投票决定是否猜测。`,
    },
    guessVotes,
  );
  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState);

  if (error) {
    throw new Error(error.message);
  }

  return toGameSession(updatedGameSession);
}

export async function finalizeTeamBattleVote(params: {
  gameSessionId: string;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("红蓝对抗结算失败：当前游戏不存在或已结束。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;

  if ((state.phase !== "REVEAL_VOTE" && state.phase !== "GUESS_VOTE") || !voteDeadlineReached(state)) {
    return { gameSession: session };
  }

  if (state.phase === "REVEAL_VOTE") {
    const revealedSet = new Set(session.revealedBlocks);
    const availableBlocks = ALL_REVEALED_BLOCKS.filter((block) => !revealedSet.has(block));
    const revealCount = Math.min(state.revealLimit, availableBlocks.length);
    const voteCounts = new Map(availableBlocks.map((block) => [block, 0]));

    for (const blocks of Object.values(state.revealVotes)) {
      for (const block of blocks) {
        if (voteCounts.has(block)) {
          voteCounts.set(block, (voteCounts.get(block) ?? 0) + 1);
        }
      }
    }

    const remaining = availableBlocks.slice();
    const selectedBlocks: number[] = [];
    let tieMessage = "";

    while (selectedBlocks.length < revealCount && remaining.length > 0) {
      const highest = Math.max(...remaining.map((block) => voteCounts.get(block) ?? 0));
      const tied = remaining.filter((block) => (voteCounts.get(block) ?? 0) === highest);
      const slots = revealCount - selectedBlocks.length;

      if (tied.length <= slots) {
        selectedBlocks.push(...tied);
      } else {
        const shuffled = tied.slice().sort(() => Math.random() - 0.5);
        selectedBlocks.push(...shuffled.slice(0, slots));
        tieMessage = `由于多个方块同票，随机选择了 ${shuffled.slice(0, slots).map((block) => block + 1).join("、")}。`;
      }

      for (const block of tied) {
        const index = remaining.indexOf(block);
        if (index >= 0) {
          remaining.splice(index, 1);
        }
      }
    }

    const nextBlocks = Array.from(new Set([...session.revealedBlocks, ...selectedBlocks])).sort((a, b) => a - b);
    const nextState: TeamBattleState = {
      ...state,
      phase: "GUESS_VOTE",
      voteDeadlineAt: null,
      revealVotes: {},
      guessVotes: {},
      pendingGuess: null,
      message: `${getTeamName(state.activeTeam)}打开了 ${selectedBlocks.map((block) => block + 1).join("、")} 号方块。${tieMessage}`,
    };
    const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState, {
      revealed_blocks: nextBlocks,
    });

    if (error) {
      throw new Error(error.message);
    }

    return { gameSession: toGameSession(updatedGameSession) };
  }

  const optionCounts = new Map<string, { count: number; vote: TeamBattleGuessVote }>();
  for (const vote of Object.values(state.guessVotes)) {
    const key = vote.type === "skip" ? "__skip__" : `guess:${vote.answerText?.trim() ?? ""}`;
    const existing = optionCounts.get(key);
    optionCounts.set(key, {
      count: (existing?.count ?? 0) + 1,
      vote,
    });
  }

  if (optionCounts.size === 0) {
    throw new Error("当前没有可结算的投票。");
  }

  const highest = Math.max(...Array.from(optionCounts.values()).map((option) => option.count));
  const tiedOptions = Array.from(optionCounts.values()).filter((option) => option.count === highest);
  const winningOption = tiedOptions.length > 1 ? randomChoice(tiedOptions) : tiedOptions[0];
  const tieMessage =
    tiedOptions.length > 1
      ? `由于最高票选项票数相同，随机选择了${winningOption.vote.type === "skip" ? "不猜" : `猜「${winningOption.vote.answerText}」`}。`
      : "";

  if (winningOption.vote.type === "skip") {
    const nextTeam = getOpposingTeam(state.activeTeam);
    const nextPhase = session.revealedBlocks.length >= REVEAL_BLOCK_COUNT ? "GUESS_VOTE" : "REVEAL_VOTE";
    const nextState: TeamBattleState = {
      ...state,
      activeTeam: nextTeam,
      phase: nextPhase,
      revealLimit: 1,
      voteDeadlineAt: null,
      revealVotes: {},
      guessVotes: {},
      pendingGuess: null,
      turnNumber: state.turnNumber + 1,
      message:
        nextPhase === "REVEAL_VOTE"
          ? `${getTeamName(state.activeTeam)}选择不猜，轮到${getTeamName(nextTeam)}打开 1 个方块。${tieMessage}`
          : `${getTeamName(state.activeTeam)}选择不猜，图片已全部打开，轮到${getTeamName(nextTeam)}决定是否猜测。${tieMessage}`,
    };
    const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState, {
      current_reveal_round: currentGameSession.current_reveal_round + 1,
    });

    if (error) {
      throw new Error(error.message);
    }

    return { gameSession: toGameSession(updatedGameSession) };
  }

  const answerText = winningOption.vote.answerText?.trim() ?? "";
  const nextState: TeamBattleState = {
    ...state,
    phase: "JUDGING",
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    pendingGuess: {
      team: state.activeTeam,
      answerText,
    },
    message: `${getTeamName(state.activeTeam)}决定猜「${answerText}」。${tieMessage}`,
  };
  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState);

  if (error) {
    throw new Error(error.message);
  }

  return { gameSession: toGameSession(updatedGameSession) };
}

export async function judgeTeamBattleGuess(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  isCorrect: boolean;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("红蓝对抗判定失败：当前游戏不存在，或你不是出题人。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;

  if (state.phase !== "JUDGING" || !state.pendingGuess) {
    throw new Error("当前没有待判定的红蓝对抗猜测。");
  }

  if (!params.isCorrect) {
    const opposingTeam = getOpposingTeam(state.pendingGuess.team);
    const nextTeam = getTeamMembers(state, opposingTeam).length > 0 ? opposingTeam : state.pendingGuess.team;
    if (getTeamMembers(state, nextTeam).length === 0) {
      throw new Error("红蓝对抗判定失败：没有可继续行动的队伍，请取消本局。");
    }

    const nextPhase = session.revealedBlocks.length >= REVEAL_BLOCK_COUNT ? "GUESS_VOTE" : "REVEAL_VOTE";
    const nextState: TeamBattleState = {
      ...state,
      activeTeam: nextTeam,
      phase: nextPhase,
      revealLimit: 2,
      voteDeadlineAt: null,
      revealVotes: {},
      guessVotes: {},
      pendingGuess: null,
      turnNumber: state.turnNumber + 1,
      message:
        nextPhase === "REVEAL_VOTE"
          ? `${getTeamName(state.pendingGuess.team)}猜错，${getTeamName(nextTeam)}本回合可以打开 2 个方块。`
          : `${getTeamName(state.pendingGuess.team)}猜错，图片已全部打开，轮到${getTeamName(nextTeam)}决定是否猜测。`,
    };
    const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState, {
      current_reveal_round: currentGameSession.current_reveal_round + 1,
    });

    if (error) {
      throw new Error(error.message);
    }

    return { gameSession: toGameSession(updatedGameSession) };
  }

  const winningTeam = state.pendingGuess.team;
  const winningMembers = getTeamMembers(state, winningTeam);
  if (winningMembers.length === 0) {
    throw new Error("红蓝对抗判定失败：猜测队伍已没有在线队员，请取消本局。");
  }

  const nextScores = {
    ...state.teamScores,
    [winningTeam]: state.teamScores[winningTeam] + 1,
  };

  for (const scoredPlayerId of winningMembers) {
    const { error: resultError } = await d1.from("question_results").insert({
      game_session_id: currentGameSession.id,
      question_index: currentGameSession.current_question_index,
      player_id: scoredPlayerId,
      scored_round: currentGameSession.current_reveal_round,
      score_awarded: 1,
      judged_by_player_id: params.presenterPlayerId,
    });

    if (resultError && !isUniqueViolation(resultError)) {
      throw new Error(resultError.message);
    }

    if (!resultError) {
      await addScoreToPlayer({
        gameSessionId: currentGameSession.id,
        playerId: scoredPlayerId,
        scoreAwarded: 1,
      });
    }
  }

  const nextState: TeamBattleState = {
    ...state,
    phase: "REVIEW",
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    pendingGuess: null,
    teamScores: nextScores,
    message: `${getTeamName(winningTeam)}猜对并获得 1 分，当前展示完整图片。`,
  };
  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState, {
    revealed_blocks: ALL_REVEALED_BLOCKS,
    round_started_at: null,
  });

  if (error) {
    throw new Error(error.message);
  }

  return { gameSession: toGameSession(updatedGameSession) };
}

export async function revealTeamBattleAnswer(params: {
  gameSessionId: string;
  presenterPlayerId: string;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("公布答案失败：当前游戏不存在，或你不是出题人。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;
  const nextState: TeamBattleState = {
    ...state,
    phase: "REVIEW",
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    pendingGuess: null,
    message: "出题人公布答案，本题双方都不加分。",
  };
  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState, {
    revealed_blocks: ALL_REVEALED_BLOCKS,
    round_started_at: null,
  });

  if (error) {
    throw new Error(error.message);
  }

  return { gameSession: toGameSession(updatedGameSession) };
}

export async function gradeAnswersAndAdvance(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  correctPlayerIds: string[];
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("判分失败：当前游戏不存在，或你不是出题人。");
  }

  if (!currentGameSession.round_started_at) {
    throw new Error("本轮尚未开始，不能进行判分。");
  }

  const currentRound = currentGameSession.current_reveal_round;
  const questionIndex = currentGameSession.current_question_index;
  const currentSession = toGameSession(currentGameSession);
  const roundScore = currentSession.roundScores[currentRound - 1] ?? Math.max(1, currentSession.maxRevealRounds - currentRound + 1);
  const eligiblePlayerIds = await getOrCreateQuestionEligiblePlayerIds({
    gameSessionId: currentGameSession.id,
    roomId: currentGameSession.room_id,
    questionIndex,
    presenterPlayerId: currentGameSession.presenter_player_id,
  });
  const eligiblePlayerSet = new Set(eligiblePlayerIds);
  const uniqueCorrectPlayerIds = Array.from(new Set(params.correctPlayerIds)).filter(
    (playerId) => playerId && playerId !== params.presenterPlayerId && eligiblePlayerSet.has(playerId),
  );
  const newlyScoredPlayerIds: string[] = [];

  for (const correctPlayerId of uniqueCorrectPlayerIds) {
    const { error } = await d1.from("question_results").insert({
      game_session_id: currentGameSession.id,
      question_index: questionIndex,
      player_id: correctPlayerId,
      scored_round: currentRound,
      score_awarded: roundScore,
      judged_by_player_id: params.presenterPlayerId,
    });

    if (error) {
      if (isUniqueViolation(error)) {
        continue;
      }

      throw new Error(error.message);
    }

    newlyScoredPlayerIds.push(correctPlayerId);
  }

  for (const scoredPlayerId of newlyScoredPlayerIds) {
    const { data: existingScore, error: scoreLoadError } = await d1
      .from("player_scores")
      .select("*")
      .eq("game_session_id", currentGameSession.id)
      .eq("player_id", scoredPlayerId)
      .maybeSingle<DbPlayerScore>();

    if (scoreLoadError) {
      throw new Error(scoreLoadError.message);
    }

    const { error: scoreError } = await d1.from("player_scores").upsert(
      {
        id: existingScore?.id,
        game_session_id: currentGameSession.id,
        player_id: scoredPlayerId,
        score: (existingScore?.score ?? 0) + roundScore,
        correct_count: (existingScore?.correct_count ?? 0) + 1,
      },
      {
        onConflict: "game_session_id,player_id",
      },
    );

    if (scoreError) {
      throw new Error(scoreError.message);
    }
  }

  const { data: questionResults, error: questionResultsError } = await d1
    .from("question_results")
    .select("*")
    .eq("game_session_id", currentGameSession.id)
    .eq("question_index", questionIndex)
    .returns<DbQuestionResult[]>();

  if (questionResultsError) {
    throw new Error(questionResultsError.message);
  }

  const correctSet = new Set((questionResults ?? []).map((result) => result.player_id));
  const allPlayersCorrect = eligiblePlayerIds.length > 0 && eligiblePlayerIds.every((guesserId) => correctSet.has(guesserId));

  if (allPlayersCorrect) {
    const reviewedGameSession = await revealQuestionForReview(currentGameSession.id);

    return {
      gameSession: reviewedGameSession,
      room: null,
      newlyScoredPlayerIds,
    };
  }

  const { data: settledGameSession, error: settleError } = await d1
    .from("game_sessions")
    .update({
      round_started_at: null,
    })
    .eq("id", currentGameSession.id)
    .select()
    .single<DbGameSession>();

  if (settleError) {
    throw new Error(settleError.message);
  }

  return {
    gameSession: toGameSession(settledGameSession),
    room: null,
    newlyScoredPlayerIds,
  };
}

export async function advanceReviewedQuestion(params: {
  gameSessionId: string;
  presenterPlayerId: string;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("进入下一题失败：当前游戏不存在或已结束。");
  }

  const { data: room, error: roomLoadError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", currentGameSession.room_id)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("current_game_id", currentGameSession.id)
    .eq("game_status", "PLAYING")
    .maybeSingle<DbRoom>();

  if (roomLoadError) {
    throw new Error(roomLoadError.message);
  }

  if (!room) {
    throw new Error("只有本局出题人可以进入下一题。");
  }

  const currentSession = toGameSession(currentGameSession);
  const isReviewingQuestion =
    !currentSession.roundStartedAt && currentSession.revealedBlocks.length === ALL_REVEALED_BLOCKS.length;

  if (!isReviewingQuestion) {
    throw new Error("当前还没有进入完整图片复盘阶段，不能进入下一题。");
  }

  const questions = await getQuestionsByQuestionSetId(currentGameSession.question_set_id);
  const nextQuestionIndex = currentGameSession.current_question_index + 1;

  if (nextQuestionIndex >= questions.length) {
    const { data: endedGameSession, error: endGameError } = await d1
      .from("game_sessions")
      .update({
        status: "GAME_RESULT",
        ended_at: new Date().toISOString(),
      })
      .eq("id", currentGameSession.id)
      .select()
      .single<DbGameSession>();

    if (endGameError) {
      throw new Error(endGameError.message);
    }

    const { data: updatedRoom, error: roomError } = await d1
      .from("rooms")
      .update({
        game_status: "GAME_RESULT",
      })
      .eq("id", currentGameSession.room_id)
      .eq("current_game_id", currentGameSession.id)
      .select()
      .single<DbRoom>();

    if (roomError) {
      throw new Error(roomError.message);
    }

    return {
      gameSession: toGameSession(endedGameSession),
      room: toRoom(updatedRoom),
    };
  }

  const eligiblePlayerIds = await createQuestionEligibilitySnapshot({
    gameSessionId: currentGameSession.id,
    roomId: currentGameSession.room_id,
    questionIndex: nextQuestionIndex,
    presenterPlayerId: currentGameSession.presenter_player_id,
  });
  const nextTeamBattleState =
    currentSession.gameMode === "TEAM_BATTLE" && currentSession.teamBattleState
      ? await resetTeamBattleStateForQuestion(
          currentSession.teamBattleState,
          currentGameSession.room_id,
          currentGameSession.presenter_player_id,
        )
      : null;

  const { data: updatedGameSession, error } = await d1
    .from("game_sessions")
    .update({
      current_question_index: nextQuestionIndex,
      current_reveal_round: 1,
      revealed_blocks: [],
      team_battle_state: nextTeamBattleState,
      round_started_at: null,
    })
    .eq("id", currentGameSession.id)
    .select()
    .single<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  const hydratedGameSession = {
    ...toGameSession(updatedGameSession),
    eligiblePlayerIds,
  };

  return {
    gameSession: hydratedGameSession,
    room: null,
  };
}

export async function updateQuestionLabel(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  questionId: string;
  labelText: string;
  source: "manual" | "answer";
  answerId?: string | null;
}) {
  assertD1Env();

  const labelText = params.labelText.trim();

  if (!labelText) {
    throw new Error("请先填写正确答案。");
  }

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("保存正确答案失败：当前游戏不存在或已结束。");
  }

  const { data: room, error: roomLoadError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", currentGameSession.room_id)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("current_game_id", currentGameSession.id)
    .eq("game_status", "PLAYING")
    .maybeSingle<DbRoom>();

  if (roomLoadError) {
    throw new Error(roomLoadError.message);
  }

  if (!room) {
    throw new Error("只有本局出题人可以填写正确答案。");
  }

  const currentSession = toGameSession(currentGameSession);
  const isReviewingQuestion =
    !currentSession.roundStartedAt && currentSession.revealedBlocks.length === ALL_REVEALED_BLOCKS.length;

  if (!isReviewingQuestion) {
    throw new Error("当前还没有进入完整图片复盘阶段，不能填写正确答案。");
  }

  const { data: question, error: questionError } = await d1
    .from("questions")
    .select("*")
    .eq("id", params.questionId)
    .eq("question_set_id", currentGameSession.question_set_id)
    .eq("order_index", currentGameSession.current_question_index)
    .maybeSingle<DbQuestion>();

  if (questionError) {
    throw new Error(questionError.message);
  }

  if (!question) {
    throw new Error("当前题目不存在，不能填写正确答案。");
  }

  if (question.label_text?.trim()) {
    throw new Error("该题已经有正确答案，不能重复填写。");
  }

  let sourceAnswerId: string | null = null;

  if (params.source === "answer") {
    if (!params.answerId) {
      throw new Error("请选择一个要引用的答案。");
    }

    const { data: answer, error: answerError } = await d1
      .from("answers")
      .select("*")
      .eq("id", params.answerId)
      .eq("game_session_id", currentGameSession.id)
      .eq("question_index", currentGameSession.current_question_index)
      .maybeSingle<DbAnswer>();

    if (answerError) {
      throw new Error(answerError.message);
    }

    if (answer) {
      sourceAnswerId = answer.id;
    } else {
      const { data: buzzerAnswer, error: buzzerAnswerError } = await d1
        .from("buzzer_answers")
        .select("*")
        .eq("id", params.answerId)
        .eq("game_session_id", currentGameSession.id)
        .eq("question_index", currentGameSession.current_question_index)
        .maybeSingle<DbBuzzerAnswer>();

      if (buzzerAnswerError) {
        throw new Error(buzzerAnswerError.message);
      }

      if (!buzzerAnswer) {
        throw new Error("引用的答案不存在，不能作为正确答案。");
      }

      sourceAnswerId = buzzerAnswer.id;
    }
  }

  const { data: updatedQuestion, error: updateError } = await d1
    .from("questions")
    .update({
      label_text: labelText,
      label_source: params.source,
      label_source_answer_id: sourceAnswerId,
      label_updated_by_player_id: params.presenterPlayerId,
      label_updated_at: new Date().toISOString(),
    })
    .eq("id", question.id)
    .is("label_text", null)
    .select()
    .maybeSingle<DbQuestion>();

  if (updateError) {
    throw new Error(updateError.message);
  }

  if (!updatedQuestion) {
    throw new Error("正确答案已被其他操作更新，请刷新后重试。");
  }

  return toQuestion(updatedQuestion);
}

export async function skipCurrentQuestion(params: {
  gameSessionId: string;
  presenterPlayerId: string;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("跳过题目失败：当前游戏不存在，或你不是出题人。");
  }

  const questions = await getQuestionsByQuestionSetId(currentGameSession.question_set_id);
  const nextQuestionIndex = currentGameSession.current_question_index + 1;

  if (nextQuestionIndex >= questions.length) {
    const { data: endedGameSession, error: endGameError } = await d1
      .from("game_sessions")
      .update({
        status: "GAME_RESULT",
        ended_at: new Date().toISOString(),
      })
      .eq("id", currentGameSession.id)
      .select()
      .single<DbGameSession>();

    if (endGameError) {
      throw new Error(endGameError.message);
    }

    const { data: updatedRoom, error: roomError } = await d1
      .from("rooms")
      .update({
        game_status: "GAME_RESULT",
      })
      .eq("id", currentGameSession.room_id)
      .select()
      .single<DbRoom>();

    if (roomError) {
      throw new Error(roomError.message);
    }

    return {
      gameSession: toGameSession(endedGameSession),
      room: toRoom(updatedRoom),
    };
  }

  const eligiblePlayerIds = await createQuestionEligibilitySnapshot({
    gameSessionId: currentGameSession.id,
    roomId: currentGameSession.room_id,
    questionIndex: nextQuestionIndex,
    presenterPlayerId: currentGameSession.presenter_player_id,
  });
  const currentSession = toGameSession(currentGameSession);
  const nextTeamBattleState =
    currentSession.gameMode === "TEAM_BATTLE" && currentSession.teamBattleState
      ? await resetTeamBattleStateForQuestion(
          currentSession.teamBattleState,
          currentGameSession.room_id,
          currentGameSession.presenter_player_id,
        )
      : null;

  const { data: updatedGameSession, error } = await d1
    .from("game_sessions")
    .update({
      current_question_index: nextQuestionIndex,
      current_reveal_round: 1,
      revealed_blocks: [],
      team_battle_state: nextTeamBattleState,
      round_started_at: null,
    })
    .eq("id", currentGameSession.id)
    .select()
    .single<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  const hydratedGameSession = {
    ...toGameSession(updatedGameSession),
    eligiblePlayerIds,
  };

  return {
    gameSession: hydratedGameSession,
    room: null,
  };
}

export async function endCurrentGameEarly(params: {
  gameSessionId: string;
  presenterPlayerId: string;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("结束游戏失败：当前游戏不存在，或你不是出题人。");
  }

  const endedAt = new Date().toISOString();
  const { data: endedGameSession, error: endGameError } = await d1
    .from("game_sessions")
    .update({
      status: "GAME_RESULT",
      ended_at: endedAt,
    })
    .eq("id", currentGameSession.id)
    .eq("status", "PLAYING")
    .select()
    .single<DbGameSession>();

  if (endGameError) {
    throw new Error(endGameError.message);
  }

  const { data: updatedRoom, error: roomError } = await d1
    .from("rooms")
    .update({
      game_status: "GAME_RESULT",
    })
    .eq("id", currentGameSession.room_id)
    .eq("current_game_id", currentGameSession.id)
    .select()
    .single<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  return {
    gameSession: toGameSession(endedGameSession),
    room: toRoom(updatedRoom),
  };
}

export async function returnRoomToLobby(roomId: string, hostPlayerId: string) {
  assertD1Env();

  const { data: room, error } = await d1
    .from("rooms")
    .update({
      current_presenter_player_id: null,
      current_game_id: null,
      prepared_question_set_id: null,
      game_status: "LOBBY",
    })
    .eq("id", roomId)
    .eq("host_player_id", hostPlayerId)
    .eq("game_status", "GAME_RESULT")
    .select()
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  if (!room) {
    throw new Error("返回大厅失败：只有房主可以在结算页返回大厅。");
  }

  return toRoom(room);
}
