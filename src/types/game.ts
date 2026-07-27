export type Player = {
  id: string;
  roomId?: string;
  nickname: string;
  isHost: boolean;
  role: PlayerRole;
  joinedAt: number | string;
  lastSeenAt?: string;
};

export type PlayerRole = "PLAYER" | "SPECTATOR";
export type RoomStatus = "LOBBY" | "QUESTION_SETUP" | "PLAYING" | "GAME_RESULT";
export type GameMode = "ROUND_REVEAL" | "BUZZER_FIRST_CORRECT" | "BUZZER_RANKED" | "TEAM_BATTLE";
export type BuzzerAnswerStatus = "pending" | "correct" | "wrong";
export type TeamBattleTeam = "red" | "blue";
export type TeamBattlePhase = "REVEAL_VOTE" | "GUESS_VOTE" | "JUDGING" | "REVIEW";

export type TeamBattleGuessVote = {
  type: "skip" | "guess";
  answerText?: string;
};

export type TeamBattlePreviousTurnAction =
  | {
      team: TeamBattleTeam;
      type: "skip";
    }
  | {
      team: TeamBattleTeam;
      type: "guess";
      answerText: string;
    };

export type TeamBattleState = {
  teams: Record<TeamBattleTeam, string[]>;
  initialTeams?: Record<TeamBattleTeam, string[]>;
  teamMemberNames?: Record<string, string>;
  activeTeam: TeamBattleTeam;
  phase: TeamBattlePhase;
  revealBlockCount?: number;
  revealLimit: number;
  turnNumber: number;
  voteDeadlineAt?: string | null;
  revealVotes: Record<string, number[]>;
  guessVotes: Record<string, TeamBattleGuessVote>;
  previousTurnAction?: TeamBattlePreviousTurnAction | null;
  pendingGuess?: {
    team: TeamBattleTeam;
    answerText: string;
  } | null;
  teamScores: Record<TeamBattleTeam, number>;
  message?: string | null;
};

export type Room = {
  id?: string;
  code: string;
  hostPlayerId: string;
  players: Player[];
  status: RoomStatus;
  currentPresenterPlayerId?: string | null;
  currentGameId?: string | null;
  preparedQuestionSetId?: string | null;
  gameMode?: GameMode;
  maxRevealRounds?: number;
  roundSeconds?: number;
  roundScores?: number[];
  createdAt: number | string;
  updatedAt?: string;
};

export type DbRoom = {
  id: string;
  room_code: string;
  host_player_id: string;
  game_status: RoomStatus;
  current_presenter_player_id: string | null;
  current_game_id: string | null;
  prepared_question_set_id?: string | null;
  lobby_game_mode?: GameMode | null;
  lobby_max_reveal_rounds?: number | null;
  lobby_round_seconds?: number | null;
  lobby_round_scores?: unknown;
  created_at: string;
  updated_at: string;
};

export type DbPlayer = {
  id: string;
  room_id: string;
  nickname: string;
  is_host: boolean;
  role?: PlayerRole | null;
  joined_at: string;
  last_seen_at: string;
};

export type QuestionSetSource = "uploaded" | "community";

export type CommunityQuestionSetSort = "latest" | "rating" | "plays";

export type CommunityQuestionSetSummary = {
  id: string;
  title: string;
  description?: string | null;
  createdByPlayerId: string;
  createdByNickname?: string | null;
  source: QuestionSetSource;
  isPublic: boolean;
  imageCount: number;
  ratingAvg: number;
  ratingCount: number;
  playCount: number;
  createdAt: string;
  updatedAt?: string | null;
};

export type CommunityQuestionSetPage = {
  items: CommunityQuestionSetSummary[];
  total: number | null;
  hasMore: boolean;
  nextOffset: number;
};

export type QuestionSet = {
  id: string;
  title: string;
  description?: string | null;
  createdByPlayerId: string;
  createdByNickname?: string | null;
  source: QuestionSetSource;
  isPublic: boolean;
  imageUrlsText?: string | null;
  imageCount: number;
  ratingAvg: number;
  ratingCount: number;
  playCount: number;
  createdAt: string;
  updatedAt?: string | null;
  questions?: Question[];
};

export type Question = {
  id: string;
  questionSetId: string;
  imageUrl: string;
  orderIndex: number;
  labelText?: string | null;
  labelSource?: "manual" | "answer" | null;
  labelSourceAnswerId?: string | null;
  labelUpdatedByPlayerId?: string | null;
  labelUpdatedAt?: string | null;
  createdAt: string;
};

export type QuestionUrlImportInput = {
  imageUrl: string;
  labelText?: string | null;
  orderIndex: number;
};

export type PreparedQuestionUrlImport = QuestionUrlImportInput & {
  originalImageUrl: string;
  r2Key?: string | null;
  importToken?: string;
  rawBytes?: number | null;
  uploadBytes?: number | null;
  usedOriginal?: boolean;
};

export type FailedQuestionUrlImport = QuestionUrlImportInput & {
  error: string;
};

export type QuestionSetUrlImportResult =
  | {
      status: "created";
      questionSet: QuestionSet;
      importedCount: number;
      fallbackCount: number;
    }
  | {
      status: "needs_decision";
      preparedQuestions: PreparedQuestionUrlImport[];
      failedQuestions: FailedQuestionUrlImport[];
      totalCount: number;
    };

export type GameSession = {
  id: string;
  roomId: string;
  questionSetId: string;
  presenterPlayerId: string;
  status: RoomStatus;
  gameMode: GameMode;
  currentQuestionIndex: number;
  currentRevealRound: number;
  revealedBlocks: number[];
  maxRevealRounds: number;
  roundSeconds: number;
  roundScores: number[];
  eligiblePlayerIds?: string[];
  roundStartedAt?: string | null;
  serverNow?: string;
  teamBattleState?: TeamBattleState | null;
  createdAt: string;
  endedAt?: string | null;
  completedNormallyAt?: string | null;
};

export type Answer = {
  id: string;
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
  playerId: string;
  answerText: string;
  submittedAt: string;
};

export type PlayerScore = {
  id: string;
  gameSessionId: string;
  playerId: string;
  score: number;
  correctCount: number;
};

export type LeaderboardEntry = {
  playerId: string;
  nickname: string;
  rank: number;
  score: number;
  correctCount: number;
};

export type QuestionResult = {
  id: string;
  gameSessionId: string;
  questionIndex: number;
  playerId: string;
  scoredRound: number;
  scoreAwarded: number;
  judgedByPlayerId: string;
  judgedAt: string;
};

export type RoundSnapshot = {
  gameSession: GameSession;
  scores: PlayerScore[];
  questionResults: QuestionResult[];
  answers: Answer[];
  labelAnswers: Answer[];
  buzzerAnswers: BuzzerAnswer[];
  labelBuzzerAnswers: BuzzerAnswer[];
};

export type GameBootstrapSnapshot = {
  gameSession: GameSession;
  questions: Question[];
  roundSnapshot: RoundSnapshot;
};

export type GameResultSnapshot = {
  gameSession: GameSession;
  leaderboard: LeaderboardEntry[];
  questionSet: QuestionSet | null;
  questionResults: QuestionResult[];
};

export type RealtimeDelta =
  | {
      scope: "room";
      type: "room_updated";
      room: Room;
    }
  | {
      scope: "room";
      type: "room_dissolved";
      roomId: string;
    }
  | {
      scope: "game";
      type: "game_session_updated";
      gameSession: GameSession;
    }
  | {
      scope: "game";
      type: "round_snapshot";
      snapshot: RoundSnapshot;
    }
  | {
      scope: "game";
      type: "game_result_snapshot";
      snapshot: GameResultSnapshot;
    }
  | {
      scope: "game";
      type: "answer_submitted";
      answer: Answer;
      buzzerAnswer?: BuzzerAnswer;
    }
  | {
      scope: "game";
      type: "answer_canceled";
      gameSession: GameSession;
      canceledAnswerId: string;
      canceledPlayerId?: string;
    }
  | {
      scope: "game";
      type: "buzzer_answer_submitted";
      buzzerAnswer: BuzzerAnswer;
    }
  | {
      scope: "game";
      type: "buzzer_answer_judged";
      gameSession: GameSession;
      buzzerAnswer: BuzzerAnswer;
      scores?: PlayerScore[];
      questionResults?: QuestionResult[];
      buzzerAnswers?: BuzzerAnswer[];
    }
  | {
      scope: "game";
      type: "answer_judgements_changed";
      gameSession: GameSession;
      answers: BuzzerAnswer[];
      scores: PlayerScore[];
      questionResults: QuestionResult[];
    }
  | {
      scope: "game";
      type: "question_label_updated";
      question: Question;
    }
  | {
      scope: "question-set";
      type: "question_set_updated";
      questionSet: QuestionSet;
      ratedPlayerId?: string;
      rating?: number;
    };

export type DbQuestionSet = {
  id: string;
  title: string;
  description: string | null;
  created_by_player_id: string;
  created_by_nickname?: string | null;
  source: QuestionSetSource;
  is_public: boolean;
  image_urls_text?: string | null;
  image_count: number;
  rating_avg: number;
  rating_count: number;
  play_count: number;
  created_at: string;
  updated_at?: string | null;
};

export type DbQuestion = {
  id: string;
  question_set_id: string;
  image_url: string;
  order_index: number;
  label_text?: string | null;
  label_source?: "manual" | "answer" | null;
  label_source_answer_id?: string | null;
  label_updated_by_player_id?: string | null;
  label_updated_at?: string | null;
  created_at: string;
};

export type DbGameSession = {
  id: string;
  room_id: string;
  question_set_id: string;
  presenter_player_id: string;
  status: RoomStatus;
  game_mode?: GameMode | null;
  current_question_index: number;
  current_reveal_round: number;
  revealed_blocks: unknown;
  max_reveal_rounds?: number;
  round_seconds?: number;
  round_scores?: unknown;
  team_battle_state?: unknown;
  round_started_at: string | null;
  created_at: string;
  ended_at: string | null;
  completed_normally_at?: string | null;
};

export type DbAnswer = {
  id: string;
  game_session_id: string;
  question_index: number;
  reveal_round: number;
  player_id: string;
  answer_text: string;
  submitted_at: string;
};

export type DbPlayerScore = {
  id: string;
  game_session_id: string;
  player_id: string;
  score: number;
  correct_count: number;
};

export type DbQuestionResult = {
  id: string;
  game_session_id: string;
  question_index: number;
  player_id: string;
  scored_round: number;
  score_awarded: number;
  judged_by_player_id: string;
  judged_at: string;
};

export type BuzzerAnswer = {
  id: string;
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
  playerId: string;
  answerText: string;
  status: BuzzerAnswerStatus;
  scoreAwarded: number;
  submittedAt: string;
  serverReceivedAt: string;
  judgedAt?: string | null;
  judgedByPlayerId?: string | null;
};

export type DbBuzzerAnswer = {
  id: string;
  game_session_id: string;
  question_index: number;
  reveal_round: number;
  player_id: string;
  answer_text: string;
  status: BuzzerAnswerStatus;
  score_awarded: number;
  submitted_at: string;
  server_received_at: string | null;
  judged_at: string | null;
  judged_by_player_id: string | null;
};

export type LocalSession = {
  playerId: string;
  nickname: string;
  roomCode?: string;
  isHost?: boolean;
};
