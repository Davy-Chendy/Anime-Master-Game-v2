import { DurableSqlDatabase } from "./durableSqlDatabase";

type Row = Record<string, unknown>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS authority_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS authority_meta (room_id TEXT PRIMARY KEY, hydrated_at TEXT NOT NULL, active_game_id TEXT, epoch TEXT NOT NULL, state_version INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS processed_actions (action_key TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS projection_outbox (projection_id TEXT PRIMARY KEY, game_session_id TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS authority_cleanup (room_id TEXT PRIMARY KEY, run_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS projected_question_labels (question_id TEXT PRIMARY KEY, label_updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS projected_question_archives (game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, projection_version INTEGER NOT NULL, PRIMARY KEY(game_session_id,question_index))`,
  `CREATE TABLE IF NOT EXISTS mutation_journal (id INTEGER PRIMARY KEY CHECK(id=1), room_id TEXT NOT NULL, name TEXT NOT NULL, action_key TEXT, started_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mutation_journal_payload (id INTEGER PRIMARY KEY CHECK(id=1), payload_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, room_code TEXT NOT NULL UNIQUE, host_player_id TEXT NOT NULL, game_status TEXT NOT NULL, current_presenter_player_id TEXT, current_game_id TEXT, prepared_question_set_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lobby_game_mode TEXT NOT NULL DEFAULT 'ROUND_REVEAL', lobby_max_reveal_rounds INTEGER NOT NULL DEFAULT 3, lobby_round_seconds INTEGER NOT NULL DEFAULT 60, lobby_round_scores TEXT NOT NULL DEFAULT '[5,3,1]')`,
  `CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, nickname TEXT NOT NULL, is_host INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'PLAYER')`,
  `CREATE TABLE IF NOT EXISTS question_sets (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, created_by_player_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'uploaded', is_public INTEGER NOT NULL DEFAULT 0, image_urls_text TEXT, image_count INTEGER NOT NULL DEFAULT 0, rating_avg REAL NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_nickname TEXT, play_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, question_set_id TEXT NOT NULL, image_url TEXT NOT NULL, order_index INTEGER NOT NULL, label_text TEXT, label_source TEXT, label_source_answer_id TEXT, label_updated_by_player_id TEXT, label_updated_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS game_sessions (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, question_set_id TEXT NOT NULL, presenter_player_id TEXT NOT NULL, status TEXT NOT NULL, game_mode TEXT NOT NULL, current_question_index INTEGER NOT NULL DEFAULT 0, current_reveal_round INTEGER NOT NULL DEFAULT 1, revealed_blocks TEXT NOT NULL DEFAULT '[]', max_reveal_rounds INTEGER NOT NULL DEFAULT 3, round_seconds INTEGER NOT NULL DEFAULT 60, round_scores TEXT NOT NULL DEFAULT '[5,3,1]', team_battle_state TEXT, round_started_at TEXT, created_at TEXT NOT NULL, ended_at TEXT, completed_normally_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, reveal_round INTEGER NOT NULL, player_id TEXT NOT NULL, answer_text TEXT NOT NULL, submitted_at TEXT NOT NULL, UNIQUE(game_session_id, question_index, reveal_round, player_id))`,
  `CREATE TABLE IF NOT EXISTS buzzer_answers (id TEXT PRIMARY KEY, game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, reveal_round INTEGER NOT NULL, player_id TEXT NOT NULL, answer_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', score_awarded INTEGER NOT NULL DEFAULT 0, submitted_at TEXT NOT NULL, server_received_at TEXT, judged_at TEXT, judged_by_player_id TEXT, UNIQUE(game_session_id, question_index, reveal_round, player_id))`,
  `CREATE TABLE IF NOT EXISTS player_scores (id TEXT PRIMARY KEY, game_session_id TEXT NOT NULL, player_id TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, correct_count INTEGER NOT NULL DEFAULT 0, UNIQUE(game_session_id, player_id))`,
  `CREATE TABLE IF NOT EXISTS question_results (id TEXT PRIMARY KEY, game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, player_id TEXT NOT NULL, scored_round INTEGER NOT NULL, score_awarded INTEGER NOT NULL, judged_by_player_id TEXT NOT NULL, judged_at TEXT NOT NULL, UNIQUE(game_session_id, question_index, player_id))`,
  `CREATE TABLE IF NOT EXISTS question_snapshots (game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, eligible_player_count INTEGER NOT NULL, eligible_player_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, PRIMARY KEY(game_session_id, question_index))`,
  `CREATE TABLE IF NOT EXISTS question_eligible_players (game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, player_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(game_session_id, question_index, player_id))`,
  `CREATE TABLE IF NOT EXISTS game_participants (game_session_id TEXT NOT NULL, player_id TEXT NOT NULL, nickname TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'PLAYER', joined_at TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(game_session_id, player_id))`,
  `CREATE TABLE IF NOT EXISTS completed_question_set_plays (game_session_id TEXT PRIMARY KEY, question_set_id TEXT NOT NULL, completed_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS question_set_ratings (id TEXT PRIMARY KEY, question_set_id TEXT NOT NULL, player_id TEXT NOT NULL, rating INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(question_set_id, player_id))`,
  `DROP TRIGGER IF EXISTS increment_local_question_set_play_count`,
] as const;

const LOCAL_TABLES = [
  "completed_question_set_plays", "question_eligible_players", "question_snapshots", "question_results",
  "player_scores", "buzzer_answers", "answers", "game_participants", "game_sessions", "questions",
  "question_sets", "players", "rooms",
] as const;

const GAME_TABLES = [
  "answers", "buzzer_answers", "player_scores", "question_results", "question_snapshots",
  "question_eligible_players", "game_participants",
] as const;

const PROJECT_TABLES = [
  "rooms", "players", "question_sets", "questions", "game_sessions", ...GAME_TABLES, "completed_question_set_plays",
] as const;

const CONFLICT_COLUMNS: Record<string, string[]> = {
  rooms: ["id"], players: ["id"], question_sets: ["id"], questions: ["id"], game_sessions: ["id"],
  answers: ["id"], buzzer_answers: ["id"], player_scores: ["id"], question_results: ["id"],
  question_snapshots: ["game_session_id", "question_index"],
  question_eligible_players: ["game_session_id", "question_index", "player_id"],
  game_participants: ["game_session_id", "player_id"], completed_question_set_plays: ["game_session_id"],
};

function quote(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

function normalizeBinding(value: unknown): SqlStorageValue {
  if (value == null || typeof value === "string" || typeof value === "number" || value instanceof ArrayBuffer) return value as SqlStorageValue;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

async function d1Rows(db: D1Database, sql: string, ...bindings: unknown[]) {
  const result = await db.prepare(sql).bind(...bindings).all<Row>();
  return result.results ?? [];
}

export type AuthorityVersion = { epoch: string; stateVersion: number };

export class RoomGameAuthority {
  readonly database: DurableSqlDatabase;
  private processedActionWrites = 0;

  constructor(private readonly storage: DurableObjectStorage, private readonly d1: D1Database) {
    this.database = new DurableSqlDatabase(storage);
  }

  initializeSchema() {
    this.storage.sql.exec(SCHEMA[0]);
    const current = this.storage.sql.exec<Row>("SELECT version FROM authority_schema WHERE id = 1").toArray()[0];
    if (Number(current?.version ?? 0) >= 5) return;
    for (const statement of SCHEMA.slice(1)) this.storage.sql.exec(statement);
    const buzzerColumns = new Set(
      this.storage.sql.exec<{ name: string }>("PRAGMA table_info(buzzer_answers)").toArray().map((column) => column.name),
    );
    if (!buzzerColumns.has("server_received_at")) {
      this.storage.sql.exec("ALTER TABLE buzzer_answers ADD COLUMN server_received_at TEXT");
    }
    this.storage.sql.exec("UPDATE buzzer_answers SET server_received_at=submitted_at WHERE server_received_at IS NULL");
    this.storage.sql.exec("CREATE INDEX IF NOT EXISTS buzzer_answers_fair_order_idx ON buzzer_answers(game_session_id,question_index,reveal_round,submitted_at,server_received_at,id)");
    this.storage.sql.exec("INSERT INTO authority_schema(id,version) VALUES(1,5) ON CONFLICT(id) DO UPDATE SET version=excluded.version");
  }

  getMeta(roomId: string) {
    return this.storage.sql.exec<Row>("SELECT * FROM authority_meta WHERE room_id = ?", roomId).toArray()[0] ?? null;
  }

  isAuthoritative(roomId: string) {
    return Boolean(this.getMeta(roomId)?.active_game_id);
  }

  async hydrate(roomId: string, force = false) {
    const current = this.getMeta(roomId);
    if (current && !force) return;
    const rooms = await d1Rows(this.d1, "SELECT * FROM rooms WHERE id = ?", roomId);
    const room = rooms[0];
    if (!room) throw new Error("房间不存在或已经解散。");
    const gameId = typeof room.current_game_id === "string" ? room.current_game_id : null;
    const playersPromise = d1Rows(this.d1, "SELECT * FROM players WHERE room_id = ?", roomId);
    const gamesPromise = gameId ? d1Rows(this.d1, "SELECT * FROM game_sessions WHERE id = ?", gameId) : Promise.resolve([]);
    const projectionPromise = gameId ? d1Rows(this.d1, "SELECT payload_json FROM game_runtime_projections WHERE game_session_id = ?", gameId).catch(() => []) : Promise.resolve([]);
    const archivesPromise = gameId ? d1Rows(this.d1, "SELECT payload_json FROM game_question_projections WHERE game_session_id = ? ORDER BY question_index", gameId).catch(() => []) : Promise.resolve([]);
    const [players, games, projections, archives] = await Promise.all([playersPromise, gamesPromise, projectionPromise, archivesPromise]);
    const projectedTables = typeof projections[0]?.payload_json === "string"
      ? (JSON.parse(projections[0].payload_json) as Record<string, Row[]>)
      : null;
    if (projectedTables) {
      for (const archive of archives) {
        if (typeof archive.payload_json !== "string") continue;
        const archiveTables = JSON.parse(archive.payload_json) as Record<string, Row[]>;
        for (const [table, rows] of Object.entries(archiveTables)) projectedTables[table] = [...(projectedTables[table] ?? []), ...rows];
      }
    }
    const game = games[0];
    const setIds = new Set<string>();
    if (typeof room.prepared_question_set_id === "string") setIds.add(room.prepared_question_set_id);
    if (typeof game?.question_set_id === "string") setIds.add(game.question_set_id);
    const questionSets = (await Promise.all([...setIds].map((id) => d1Rows(this.d1, "SELECT * FROM question_sets WHERE id = ?", id)))).flat();
    const questions = (await Promise.all([...setIds].map((id) => d1Rows(this.d1, "SELECT * FROM questions WHERE question_set_id = ? ORDER BY order_index", id)))).flat();
    const perGame = gameId && !projectedTables
      ? await Promise.all([
          d1Rows(this.d1, "SELECT * FROM answers WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM buzzer_answers WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM player_scores WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM question_results WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM question_snapshots WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM question_eligible_players WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM game_participants WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM completed_question_set_plays WHERE game_session_id = ?", gameId),
        ])
      : [[], [], [], [], [], [], [], []];
    if (projectedTables) {
      projectedTables.rooms = rooms;
      if (!gameId) projectedTables.players = players;
      projectedTables.question_sets = questionSets;
      projectedTables.questions = questions;
      projectedTables.game_sessions = games;
    }
    const rowsByTable: Record<string, Row[]> = projectedTables ?? {
      rooms, players, question_sets: questionSets, questions, game_sessions: games,
      answers: perGame[0], buzzer_answers: perGame[1], player_scores: perGame[2], question_results: perGame[3],
      question_snapshots: perGame[4], question_eligible_players: perGame[5], game_participants: perGame[6], completed_question_set_plays: perGame[7],
    };
    return this.storage.transactionSync(() => {
      for (const table of LOCAL_TABLES) this.storage.sql.exec(`DELETE FROM ${quote(table)}`);
      for (const [table, rows] of Object.entries(rowsByTable)) for (const row of rows) this.insertLocal(table, row);
      const epoch = !current ? crypto.randomUUID() : String(current.epoch);
      const stateVersion = Math.max(Number(current?.state_version ?? 0), Date.now() * 1000);
      this.storage.sql.exec(
        "INSERT INTO authority_meta(room_id, hydrated_at, active_game_id, epoch, state_version) VALUES(?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET hydrated_at=excluded.hydrated_at, active_game_id=excluded.active_game_id, epoch=excluded.epoch",
        roomId, new Date().toISOString(), gameId, epoch, stateVersion,
      );
      if (gameId) this.storage.sql.exec("DELETE FROM authority_cleanup WHERE room_id = ?", roomId);
    });
  }

  bumpVersion(roomId: string): AuthorityVersion {
    this.storage.sql.exec("UPDATE authority_meta SET state_version = state_version + 1 WHERE room_id = ?", roomId);
    const meta = this.getMeta(roomId);
    return { epoch: String(meta?.epoch ?? ""), stateVersion: Number(meta?.state_version ?? 0) };
  }

  commitMutation(roomId: string, actionKey: string | null, result: unknown, projectionReason: string | null) {
    return this.storage.transactionSync(() => {
      const version = this.bumpVersion(roomId);
      if (actionKey) this.rememberAction(actionKey, result);
      if (projectionReason) this.enqueueProjection(roomId, projectionReason);
      this.storage.sql.exec("DELETE FROM mutation_journal WHERE id = 1");
      this.storage.sql.exec("DELETE FROM mutation_journal_payload WHERE id = 1");
      return version;
    });
  }

  beginMutation(roomId: string, name: string, actionKey: string | null, payload: unknown) {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT INTO mutation_journal(id,room_id,name,action_key,started_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,name=excluded.name,action_key=excluded.action_key,started_at=excluded.started_at",
        roomId, name, actionKey, Date.now(),
      );
      this.storage.sql.exec("INSERT INTO mutation_journal_payload(id,payload_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json", JSON.stringify(payload ?? null));
    });
  }

  abortMutation(roomId: string) {
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM mutation_journal WHERE id = 1 AND room_id = ?", roomId);
      this.storage.sql.exec("DELETE FROM mutation_journal_payload WHERE id = 1");
    });
  }

  recoverIncompleteMutation(roomId: string) {
    const journal = this.storage.sql.exec<Row>("SELECT * FROM mutation_journal WHERE id = 1 AND room_id = ?", roomId).toArray()[0];
    if (!journal) return;
    const payloadRow = this.storage.sql.exec<Row>("SELECT payload_json FROM mutation_journal_payload WHERE id = 1").toArray()[0];
    const actionArgs = typeof payloadRow?.payload_json === "string" ? JSON.parse(payloadRow.payload_json) as unknown[] : [];
    return this.storage.transactionSync(() => {
      // A correct result is the durable scoring fact. Repair denormalized score
      // and buzzer rows if an isolate stopped between gameService statements.
      const name = String(journal.name);
      if (name === "gradeAnswersAndAdvance") {
        const params = (Array.isArray(actionArgs) ? actionArgs[0] : null) as { correctPlayerIds?: unknown[]; presenterPlayerId?: string } | null;
        const session = this.storage.sql.exec<Row>("SELECT * FROM game_sessions WHERE room_id = ? AND status = 'PLAYING' LIMIT 1", roomId).toArray()[0];
        if (session) {
          const eligible = new Set(this.storage.sql.exec<Row>("SELECT player_id FROM question_eligible_players WHERE game_session_id = ? AND question_index = ?", session.id, session.current_question_index).toArray().map((row) => String(row.player_id)));
          const correctIds = [...new Set((params?.correctPlayerIds ?? []).filter((id): id is string => typeof id === "string" && eligible.has(id)))];
          const scores = typeof session.round_scores === "string" ? JSON.parse(session.round_scores) as number[] : [];
          const scoreAwarded = Number(scores[Number(session.current_reveal_round) - 1] ?? Math.max(1, Number(session.max_reveal_rounds) - Number(session.current_reveal_round) + 1));
          for (const playerId of correctIds) {
            this.storage.sql.exec(`INSERT OR IGNORE INTO question_results(id,game_session_id,question_index,player_id,scored_round,score_awarded,judged_by_player_id,judged_at)
              VALUES(?,?,?,?,?,?,?,?)`, `${session.id}:${session.current_question_index}:${playerId}:recovered`, session.id, session.current_question_index, playerId,
              session.current_reveal_round, scoreAwarded, params?.presenterPlayerId ?? session.presenter_player_id, new Date().toISOString());
          }
        }
      }
      this.storage.sql.exec(`UPDATE question_results SET score_awarded=MAX(1,
        (SELECT COUNT(*) FROM question_eligible_players ep WHERE ep.game_session_id=question_results.game_session_id AND ep.question_index=question_results.question_index)
        - (SELECT COUNT(*) FROM buzzer_answers earlier JOIN question_results er ON er.game_session_id=earlier.game_session_id AND er.question_index=earlier.question_index AND er.player_id=earlier.player_id
           WHERE earlier.game_session_id=question_results.game_session_id AND earlier.question_index=question_results.question_index AND earlier.status='correct'
             AND (earlier.submitted_at < (SELECT submitted_at FROM buzzer_answers mine WHERE mine.game_session_id=question_results.game_session_id AND mine.question_index=question_results.question_index AND mine.player_id=question_results.player_id)
               OR (earlier.submitted_at = (SELECT submitted_at FROM buzzer_answers mine WHERE mine.game_session_id=question_results.game_session_id AND mine.question_index=question_results.question_index AND mine.player_id=question_results.player_id) AND er.judged_at < question_results.judged_at))))
        WHERE game_session_id IN (SELECT id FROM game_sessions WHERE game_mode='BUZZER_RANKED')`);
      this.storage.sql.exec(`UPDATE buzzer_answers SET
        status='correct',
        score_awarded=(SELECT qr.score_awarded FROM question_results qr WHERE qr.game_session_id=buzzer_answers.game_session_id AND qr.question_index=buzzer_answers.question_index AND qr.player_id=buzzer_answers.player_id),
        judged_at=COALESCE(judged_at,(SELECT qr.judged_at FROM question_results qr WHERE qr.game_session_id=buzzer_answers.game_session_id AND qr.question_index=buzzer_answers.question_index AND qr.player_id=buzzer_answers.player_id)),
        judged_by_player_id=COALESCE(judged_by_player_id,(SELECT qr.judged_by_player_id FROM question_results qr WHERE qr.game_session_id=buzzer_answers.game_session_id AND qr.question_index=buzzer_answers.question_index AND qr.player_id=buzzer_answers.player_id))
        WHERE EXISTS(SELECT 1 FROM question_results qr WHERE qr.game_session_id=buzzer_answers.game_session_id AND qr.question_index=buzzer_answers.question_index AND qr.player_id=buzzer_answers.player_id)`);
      this.storage.sql.exec(`UPDATE player_scores SET
        score=COALESCE((SELECT SUM(qr.score_awarded) FROM question_results qr WHERE qr.game_session_id=player_scores.game_session_id AND qr.player_id=player_scores.player_id),0),
        correct_count=(SELECT COUNT(*) FROM question_results qr WHERE qr.game_session_id=player_scores.game_session_id AND qr.player_id=player_scores.player_id)
        WHERE score != COALESCE((SELECT SUM(qr.score_awarded) FROM question_results qr WHERE qr.game_session_id=player_scores.game_session_id AND qr.player_id=player_scores.player_id),0)
           OR correct_count != (SELECT COUNT(*) FROM question_results qr WHERE qr.game_session_id=player_scores.game_session_id AND qr.player_id=player_scores.player_id)`);
      this.storage.sql.exec(`INSERT INTO player_scores(id,game_session_id,player_id,score,correct_count)
        SELECT question_results.game_session_id || ':' || question_results.player_id || ':recovered', question_results.game_session_id,
               question_results.player_id, SUM(question_results.score_awarded), COUNT(*)
        FROM question_results GROUP BY question_results.game_session_id,question_results.player_id
        ON CONFLICT(game_session_id,player_id) DO UPDATE SET score=excluded.score,correct_count=excluded.correct_count`);
      this.storage.sql.exec(`INSERT OR IGNORE INTO answers(id,game_session_id,question_index,reveal_round,player_id,answer_text,submitted_at)
        SELECT buzzer_answers.id || ':recovered', buzzer_answers.game_session_id, buzzer_answers.question_index, buzzer_answers.reveal_round,
               buzzer_answers.player_id, buzzer_answers.answer_text, buzzer_answers.submitted_at
        FROM buzzer_answers JOIN game_sessions ON game_sessions.id=buzzer_answers.game_session_id
        WHERE game_sessions.game_mode='ROUND_REVEAL' AND NOT EXISTS(
          SELECT 1 FROM answers WHERE answers.game_session_id=buzzer_answers.game_session_id AND answers.question_index=buzzer_answers.question_index
            AND answers.reveal_round=buzzer_answers.reveal_round AND answers.player_id=buzzer_answers.player_id)`);
      this.storage.sql.exec(`UPDATE rooms SET game_status='GAME_RESULT', updated_at=? WHERE current_game_id IN (SELECT id FROM game_sessions WHERE status='GAME_RESULT') AND game_status='PLAYING'`, new Date().toISOString());
      this.storage.sql.exec(`UPDATE game_sessions SET revealed_blocks=?,round_started_at=NULL
        WHERE game_mode='BUZZER_FIRST_CORRECT' AND status='PLAYING' AND EXISTS(
          SELECT 1 FROM question_results WHERE question_results.game_session_id=game_sessions.id AND question_results.question_index=game_sessions.current_question_index)`,
        JSON.stringify(Array.from({ length: 45 }, (_, index) => index)));
      const validPlayerIds = new Set(this.storage.sql.exec<Row>("SELECT id FROM players WHERE room_id = ? AND role = 'PLAYER'", roomId).toArray().map((row) => String(row.id)));
      for (const session of this.storage.sql.exec<Row>("SELECT id,team_battle_state FROM game_sessions WHERE room_id = ? AND game_mode = 'TEAM_BATTLE' AND status = 'PLAYING'", roomId).toArray()) {
        if (typeof session.team_battle_state !== "string") continue;
        const state = JSON.parse(session.team_battle_state) as { teams?: { red?: string[]; blue?: string[] }; revealVotes?: Record<string, unknown>; guessVotes?: Record<string, unknown>; teamMemberNames?: Record<string, string>; activeTeam?: "red" | "blue"; voteDeadlineAt?: string | null; pendingGuess?: unknown };
        if (!state.teams) continue;
        state.teams.red = (state.teams.red ?? []).filter((id) => validPlayerIds.has(id));
        state.teams.blue = (state.teams.blue ?? []).filter((id) => validPlayerIds.has(id));
        for (const votes of [state.revealVotes, state.guessVotes, state.teamMemberNames]) if (votes) for (const id of Object.keys(votes)) if (!validPlayerIds.has(id)) delete votes[id];
        if (state.activeTeam && (state.teams[state.activeTeam] ?? []).length === 0) {
          state.activeTeam = state.activeTeam === "red" ? "blue" : "red";
          state.voteDeadlineAt = null;
          state.revealVotes = {};
          state.guessVotes = {};
          state.pendingGuess = null;
        }
        if (name === "judgeTeamBattleGuess" && (state as { phase?: string }).phase === "JUDGING" && state.pendingGuess && typeof state.pendingGuess === "object") {
          const pending = state.pendingGuess as { team?: "red" | "blue" };
          const winningTeam = pending.team;
          const hasWinningResult = winningTeam && this.storage.sql.exec<Row>(
            "SELECT 1 AS found FROM question_results WHERE game_session_id = ? AND question_index = (SELECT current_question_index FROM game_sessions WHERE id = ?) LIMIT 1",
            session.id, session.id,
          ).toArray()[0];
          if (winningTeam && hasWinningResult) {
            const mutable = state as typeof state & { phase?: string; teamScores?: Record<"red" | "blue", number>; message?: string; revealVotes?: Record<string, unknown>; guessVotes?: Record<string, unknown> };
            mutable.phase = "REVIEW";
            mutable.teamScores = { red: mutable.teamScores?.red ?? 0, blue: mutable.teamScores?.blue ?? 0 };
            mutable.teamScores[winningTeam] += 1;
            mutable.voteDeadlineAt = null;
            mutable.revealVotes = {};
            mutable.guessVotes = {};
            mutable.pendingGuess = null;
            this.storage.sql.exec("UPDATE game_sessions SET revealed_blocks = ?, round_started_at = NULL WHERE id = ?", JSON.stringify(Array.from({ length: 45 }, (_, index) => index)), session.id);
          }
        }
        this.storage.sql.exec("UPDATE game_sessions SET team_battle_state = ? WHERE id = ?", JSON.stringify(state), session.id);
      }
      if (name === "gradeAnswersAndAdvance") {
        this.storage.sql.exec(`UPDATE game_sessions SET
          revealed_blocks=CASE WHEN NOT EXISTS(
            SELECT 1 FROM question_eligible_players ep WHERE ep.game_session_id=game_sessions.id AND ep.question_index=game_sessions.current_question_index
              AND NOT EXISTS(SELECT 1 FROM question_results qr WHERE qr.game_session_id=ep.game_session_id AND qr.question_index=ep.question_index AND qr.player_id=ep.player_id)
          ) THEN ? ELSE revealed_blocks END,
          round_started_at=NULL
          WHERE room_id=? AND status='PLAYING'`, JSON.stringify(Array.from({ length: 45 }, (_, index) => index)), roomId);
      }
      const roomState = this.storage.sql.exec<Row>("SELECT * FROM rooms WHERE id = ?", roomId).toArray()[0];
      const remainingPlayers = this.storage.sql.exec<Row>("SELECT * FROM players WHERE room_id = ? ORDER BY joined_at,id", roomId).toArray();
      if (roomState && !remainingPlayers.some((player) => player.id === roomState.host_player_id)) {
        const nextHost = remainingPlayers[0];
        if (!nextHost) this.storage.sql.exec("DELETE FROM rooms WHERE id = ?", roomId);
        else {
          this.storage.sql.exec("UPDATE players SET is_host = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE room_id = ?", nextHost.id, roomId);
          this.storage.sql.exec("UPDATE rooms SET host_player_id = ? WHERE id = ?", nextHost.id, roomId);
        }
      }
      if (roomState?.game_status === "QUESTION_SETUP" && !remainingPlayers.some((player) => player.id === roomState.current_presenter_player_id)) {
        this.storage.sql.exec("UPDATE rooms SET game_status='LOBBY',current_presenter_player_id=NULL,current_game_id=NULL,prepared_question_set_id=NULL WHERE id = ?", roomId);
      }
      const room = this.storage.sql.exec<Row>("SELECT game_status FROM rooms WHERE id = ?", roomId).toArray()[0];
      const handoffApplied = name === "dissolveRoom" ? !room : ["returnRoomToLobby", "cancelCurrentRound"].includes(name) && room?.game_status === "LOBBY";
      const version = this.bumpVersion(roomId);
      const canReturnRecoveredReceipt = [
        "submitAnswer", "submitForfeitAnswer", "cancelForfeitAnswer", "judgeBuzzerAnswer",
        "joinRoom", "leaveRoom", "kickPlayerFromRoom", "updatePlayerRole", "judgeTeamBattleGuess", "gradeAnswersAndAdvance",
      ].includes(name) || handoffApplied;
      if (canReturnRecoveredReceipt && typeof journal.action_key === "string" && journal.action_key) {
        this.rememberAction(journal.action_key, { __authorityRecovered: true });
      }
      if (handoffApplied) {
        this.enqueueProjection(roomId, name);
      }
      this.storage.sql.exec("DELETE FROM mutation_journal WHERE id = 1");
      this.storage.sql.exec("DELETE FROM mutation_journal_payload WHERE id = 1");
      return version;
    });
  }

  releaseGame(roomId: string) {
    this.storage.sql.exec("UPDATE authority_meta SET active_game_id = NULL WHERE room_id = ?", roomId);
    this.storage.sql.exec("INSERT INTO authority_cleanup(room_id,run_at) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET run_at=excluded.run_at", roomId, Date.now() + 60 * 60 * 1000);
  }

  purgeRoom(roomId: string) {
    this.storage.transactionSync(() => {
      for (const table of LOCAL_TABLES) this.storage.sql.exec(`DELETE FROM ${quote(table)}`);
      this.storage.sql.exec("DELETE FROM processed_actions");
      this.storage.sql.exec("DELETE FROM projection_outbox");
      this.storage.sql.exec("DELETE FROM authority_meta WHERE room_id = ?", roomId);
      this.storage.sql.exec("DELETE FROM authority_cleanup WHERE room_id = ?", roomId);
      this.storage.sql.exec("DELETE FROM projected_question_labels");
      this.storage.sql.exec("DELETE FROM projected_question_archives");
      this.storage.sql.exec("DELETE FROM mutation_journal");
      this.storage.sql.exec("DELETE FROM mutation_journal_payload");
    });
  }

  getProcessedAction(actionKey: string) {
    const row = this.storage.sql.exec<Row>("SELECT result_json FROM processed_actions WHERE action_key = ?", actionKey).toArray()[0];
    return typeof row?.result_json === "string" ? JSON.parse(row.result_json) : null;
  }

  rememberAction(actionKey: string, result: unknown) {
    this.storage.sql.exec(
      "INSERT INTO processed_actions(action_key,result_json,created_at) VALUES(?,?,?) ON CONFLICT(action_key) DO UPDATE SET result_json=excluded.result_json, created_at=excluded.created_at",
      actionKey, JSON.stringify(result), Date.now(),
    );
    this.processedActionWrites += 1;
    if (this.processedActionWrites % 32 === 0) {
      this.storage.sql.exec("DELETE FROM processed_actions WHERE action_key IN (SELECT action_key FROM processed_actions ORDER BY created_at DESC LIMIT -1 OFFSET 256)");
    }
  }

  enqueueProjection(roomId: string, reason: string) {
    const meta = this.getMeta(roomId);
    const gameId = String(meta?.active_game_id ?? "");
    if (!gameId) return;
    const existing = this.storage.sql.exec<Row>("SELECT payload_json FROM projection_outbox LIMIT 1").toArray()[0];
    let syncPlayers = ["joinRoom", "leaveRoom", "kickPlayerFromRoom", "updatePlayerRole"].includes(reason);
    if (typeof existing?.payload_json === "string") {
      const existingPayload = JSON.parse(existing.payload_json) as { reason?: string; syncPlayers?: boolean };
      if (["returnRoomToLobby", "cancelCurrentRound", "dissolveRoom"].includes(existingPayload.reason ?? "")) return;
      syncPlayers ||= existingPayload.syncPlayers === true;
    }
    const payload: Record<string, Row[]> = {};
    for (const table of PROJECT_TABLES) payload[table] = this.storage.sql.exec<Row>(`SELECT * FROM ${quote(table)}`).toArray();
    const currentQuestionIndex = Number(payload.game_sessions?.[0]?.current_question_index ?? 0);
    const archiveIndexes = Array.from({ length: currentQuestionIndex }, (_, index) => index).filter((questionIndex) =>
      !this.storage.sql.exec<Row>("SELECT 1 AS found FROM projected_question_archives WHERE game_session_id = ? AND question_index = ?", gameId, questionIndex).toArray()[0],
    );
    const questionScopedTables = ["answers", "buzzer_answers", "question_results", "question_snapshots", "question_eligible_players"];
    const archives: Record<string, Record<string, Row[]>> = {};
    for (const questionIndex of archiveIndexes) {
      archives[String(questionIndex)] = Object.fromEntries(questionScopedTables.map((table) => [
        table,
        (payload[table] ?? []).filter((row) => Number(row.question_index) === questionIndex),
      ]));
    }
    for (const table of questionScopedTables) payload[table] = (payload[table] ?? []).filter((row) => Number(row.question_index) === currentQuestionIndex);
    const dirtyQuestionIds = (payload.questions ?? []).filter((question) => {
      if (typeof question.label_updated_at !== "string") return false;
      const receipt = this.storage.sql.exec<Row>("SELECT label_updated_at FROM projected_question_labels WHERE question_id = ?", question.id).toArray()[0];
      return receipt?.label_updated_at !== question.label_updated_at;
    }).map((question) => String(question.id));
    const version = Number(meta?.state_version ?? 0);
    const projectionId = `${gameId}:${version}`;
    // Every projection is a complete recovery image; a newer pending image
    // supersedes older pending work and keeps the outbox bounded to one row.
    this.storage.sql.exec("DELETE FROM projection_outbox");
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO projection_outbox(projection_id,game_session_id,version,payload_json,attempts,next_attempt_at) VALUES(?,?,?,?,0,?)",
      projectionId, gameId, version, JSON.stringify({ roomId, gameId, reason, version, syncPlayers, dirtyQuestionIds, archives, tables: payload }), Date.now(),
    );
  }

  hasPendingProjection() {
    return this.storage.sql.exec<Row>("SELECT projection_id FROM projection_outbox LIMIT 1").toArray().length > 0;
  }

  hasPendingHandoff() {
    const row = this.storage.sql.exec<Row>("SELECT payload_json FROM projection_outbox LIMIT 1").toArray()[0];
    if (typeof row?.payload_json !== "string") return false;
    const reason = (JSON.parse(row.payload_json) as { reason?: string }).reason ?? "";
    return ["returnRoomToLobby", "cancelCurrentRound", "dissolveRoom"].includes(reason);
  }

  async flushProjections(limit = 4) {
    const head = this.storage.sql.exec<Row>("SELECT * FROM projection_outbox ORDER BY version ASC LIMIT 1").toArray()[0];
    const pending = head && Number(head.next_attempt_at) <= Date.now() ? [head] : [];
    for (const item of pending) {
      try {
        const payload = JSON.parse(String(item.payload_json)) as { roomId: string; gameId: string; reason: string; version: number; syncPlayers: boolean; dirtyQuestionIds: string[]; archives: Record<string, Record<string, Row[]>>; tables: Record<string, Row[]> };
        await this.projectPayload(payload);
        if (payload.reason === "dissolveRoom") {
          this.purgeRoom(payload.roomId);
        } else {
          this.storage.transactionSync(() => {
            this.storage.sql.exec("DELETE FROM projection_outbox WHERE projection_id = ?", item.projection_id);
            if (["returnRoomToLobby", "cancelCurrentRound"].includes(payload.reason)) this.releaseGame(payload.roomId);
            for (const questionId of payload.dirtyQuestionIds ?? []) {
              const question = payload.tables.questions?.find((row) => row.id === questionId);
              this.storage.sql.exec("INSERT INTO projected_question_labels(question_id,label_updated_at) VALUES(?,?) ON CONFLICT(question_id) DO UPDATE SET label_updated_at=excluded.label_updated_at", questionId, question?.label_updated_at ?? null);
            }
            for (const questionIndex of Object.keys(payload.archives ?? {})) {
              this.storage.sql.exec("INSERT INTO projected_question_archives(game_session_id,question_index,projection_version) VALUES(?,?,?) ON CONFLICT(game_session_id,question_index) DO UPDATE SET projection_version=excluded.projection_version", payload.gameId, Number(questionIndex), payload.version);
            }
          });
        }
      } catch (error) {
        const attempts = Number(item.attempts ?? 0) + 1;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
        this.storage.sql.exec(
          "UPDATE projection_outbox SET attempts = ?, next_attempt_at = ? WHERE projection_id = ?",
          attempts, Date.now() + delay, item.projection_id,
        );
        throw error;
      }
    }
  }

  getNextProjectionAt() {
    const row = this.storage.sql.exec<Row>("SELECT MIN(next_attempt_at) AS next_at FROM projection_outbox").toArray()[0];
    return typeof row?.next_at === "number" ? row.next_at : null;
  }

  getNextCleanupAt() {
    const row = this.storage.sql.exec<Row>("SELECT MIN(run_at) AS run_at FROM authority_cleanup").toArray()[0];
    return typeof row?.run_at === "number" ? row.run_at : null;
  }

  cleanupIfDue(now = Date.now()) {
    const row = this.storage.sql.exec<Row>("SELECT room_id,run_at FROM authority_cleanup ORDER BY run_at LIMIT 1").toArray()[0];
    if (!row || Number(row.run_at) > now || this.hasPendingProjection()) return;
    const roomId = String(row.room_id);
    if (this.isAuthoritative(roomId)) {
      this.storage.sql.exec("DELETE FROM authority_cleanup WHERE room_id = ?", roomId);
      return;
    }
    this.purgeRoom(roomId);
  }

  async loadGameProjection(gameSessionId: string) {
    if (this.storage.sql.exec<Row>("SELECT id FROM game_sessions WHERE id = ?", gameSessionId).toArray()[0]) return;
    const activeGameId = this.storage.sql.exec<Row>("SELECT active_game_id FROM authority_meta LIMIT 1").toArray()[0]?.active_game_id;
    if (typeof activeGameId === "string" && activeGameId && activeGameId !== gameSessionId) {
      throw new Error("当前房间正在进行新游戏，旧局详情请在本局结束后查看。");
    }
    const [rows, archives] = await Promise.all([
      d1Rows(this.d1, "SELECT payload_json FROM game_runtime_projections WHERE game_session_id = ?", gameSessionId),
      d1Rows(this.d1, "SELECT payload_json FROM game_question_projections WHERE game_session_id = ? ORDER BY question_index", gameSessionId),
    ]);
    if (typeof rows[0]?.payload_json !== "string") return;
    const tables = JSON.parse(rows[0].payload_json) as Record<string, Row[]>;
    for (const archive of archives) {
      if (typeof archive.payload_json !== "string") continue;
      const archiveTables = JSON.parse(archive.payload_json) as Record<string, Row[]>;
      for (const [table, tableRows] of Object.entries(archiveTables)) tables[table] = [...(tables[table] ?? []), ...tableRows];
    }
    this.storage.transactionSync(() => {
      for (const table of LOCAL_TABLES) this.storage.sql.exec(`DELETE FROM ${quote(table)}`);
      for (const [table, tableRows] of Object.entries(tables)) {
        if (!(LOCAL_TABLES as readonly string[]).includes(table)) continue;
        for (const row of tableRows) this.insertLocal(table, row);
      }
    });
  }

  private async projectPayload(payload: { roomId: string; gameId: string; reason: string; version: number; syncPlayers: boolean; dirtyQuestionIds: string[]; archives: Record<string, Record<string, Row[]>>; tables: Record<string, Row[]> }) {
    const statements: D1PreparedStatement[] = [];
    const appendUpserts = (table: string, rows: Row[], conflicts: string[]) => {
      if (!rows.length) return;
      const groups = new Map<string, Row[]>();
      for (const row of rows) {
        const key = Object.keys(row).join("\u0000");
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const group of groups.values()) {
        const columns = Object.keys(group[0]);
        const updates = columns.filter((column) => !conflicts.includes(column));
        const conflictSql = updates.length ? `DO UPDATE SET ${updates.map((column) => `${quote(column)}=excluded.${quote(column)}`).join(",")}` : "DO NOTHING";
        const rowsPerStatement = Math.max(1, Math.floor(90 / columns.length));
        for (let start = 0; start < group.length; start += rowsPerStatement) {
          const chunk = group.slice(start, start + rowsPerStatement);
          const placeholders = chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
          statements.push(this.d1.prepare(
            `INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES ${placeholders} ON CONFLICT (${conflicts.map(quote).join(",")}) ${conflictSql}`,
          ).bind(...chunk.flatMap((row) => columns.map((column) => row[column] as D1_TYPE))));
        }
      }
    };
    if (!payload.tables.rooms?.[0]) {
      statements.push(this.d1.prepare("DELETE FROM rooms WHERE id = ?").bind(payload.roomId));
      statements.push(this.d1.prepare("DELETE FROM game_runtime_projections WHERE game_session_id = ?").bind(payload.gameId));
      statements.push(this.d1.prepare("DELETE FROM game_question_projections WHERE game_session_id = ?").bind(payload.gameId));
      await this.d1.batch(statements);
      return;
    }
    const compactPayload = JSON.stringify(payload.tables);
    statements.push(this.d1.prepare(
      `INSERT INTO game_runtime_projections(game_session_id,room_id,projection_version,payload_json,updated_at)
       VALUES(?,?,?,?,?) ON CONFLICT(game_session_id) DO UPDATE SET
       room_id=excluded.room_id, projection_version=excluded.projection_version,
       payload_json=excluded.payload_json, updated_at=excluded.updated_at
       WHERE excluded.projection_version >= game_runtime_projections.projection_version`,
    ).bind(payload.gameId, payload.roomId, payload.version, compactPayload, new Date().toISOString()));
    appendUpserts("game_question_projections", Object.entries(payload.archives ?? {}).map(([questionIndex, archive]) => ({
      game_session_id: payload.gameId,
      question_index: Number(questionIndex),
      projection_version: payload.version,
      payload_json: JSON.stringify(archive),
      updated_at: new Date().toISOString(),
    })), ["game_session_id", "question_index"]);

    const room = payload.tables.rooms?.[0];
    const game = payload.tables.game_sessions?.find((row) => row.id === payload.gameId);
    const completed = payload.tables.completed_question_set_plays ?? [];
    const coreTables: Array<[string, Row[]]> = [["rooms", room ? [room] : []], ["game_sessions", game ? [game] : []], ["completed_question_set_plays", completed]];
    if (room?.game_status !== "PLAYING" || payload.syncPlayers) {
      statements.push(this.d1.prepare("DELETE FROM players WHERE room_id = ?").bind(payload.roomId));
      coreTables.push(["players", payload.tables.players ?? []]);
    }
    if ((payload.dirtyQuestionIds ?? []).length > 0) {
      const dirtyIds = new Set(payload.dirtyQuestionIds);
      const changed = (payload.tables.questions ?? []).filter((row) => dirtyIds.has(String(row.id)));
      coreTables.push(["questions", changed]);
    }
    for (const [table, rows] of coreTables) {
      const conflicts = CONFLICT_COLUMNS[table];
      if (conflicts) appendUpserts(table, rows, conflicts);
    }
    if (statements.length) await this.d1.batch(statements);
  }

  private insertLocal(table: string, row: Row) {
    const normalizedRow =
      table === "buzzer_answers" && typeof row.server_received_at !== "string"
        ? { ...row, server_received_at: row.submitted_at }
        : row;
    const columns = Object.keys(normalizedRow);
    if (!columns.length) return;
    this.storage.sql.exec(
      `INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      ...columns.map((column) => normalizeBinding(normalizedRow[column])),
    );
  }
}
