type QueryError = {
  message: string;
  code?: string;
};

type QueryResult<T = unknown> = {
  data: T | null;
  error: QueryError | null;
};

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "is"; column: string; value: null };

type OrderBy = {
  column: string;
  ascending: boolean;
};

const JSON_COLUMNS = new Set(["revealed_blocks", "round_scores", "team_battle_state", "lobby_round_scores"]);
const BOOLEAN_COLUMNS = new Set(["is_host", "is_public"]);
const UPDATED_AT_TABLES = new Set(["rooms", "question_sets", "question_set_ratings"]);
const ID_TABLES = new Set([
  "rooms",
  "question_sets",
  "questions",
  "game_sessions",
  "answers",
  "player_scores",
  "question_results",
  "question_set_ratings",
  "buzzer_answers",
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeValue(column: string, value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (JSON_COLUMNS.has(column)) {
    return JSON.stringify(value ?? []);
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return value;
}

function denormalizeRow<T>(row: Record<string, unknown>): T {
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (JSON_COLUMNS.has(key) && typeof value === "string") {
      try {
        next[key] = JSON.parse(value);
      } catch {
        next[key] = [];
      }
      continue;
    }

    if (BOOLEAN_COLUMNS.has(key)) {
      next[key] = Boolean(value);
      continue;
    }

    next[key] = value;
  }

  return next as T;
}

function cleanRecord(table: string, record: Record<string, unknown>) {
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    const normalized = normalizeValue(key, value);
    if (normalized !== undefined) {
      next[key] = normalized;
    }
  }

  if (ID_TABLES.has(table) && !next.id) {
    next.id = crypto.randomUUID();
  }

  const now = nowIso();
  if (
    ["rooms", "question_sets", "questions", "game_sessions", "question_set_ratings"].includes(table) &&
    !("created_at" in next)
  ) {
    next.created_at = now;
  }
  if (UPDATED_AT_TABLES.has(table)) {
    next.updated_at = now;
  }
  if (table === "players" && !("joined_at" in next)) {
    next.joined_at = now;
  }
  if (table === "answers" && !("submitted_at" in next)) {
    next.submitted_at = now;
  }
  if (table === "buzzer_answers" && !("submitted_at" in next)) {
    next.submitted_at = now;
  }
  if (table === "question_results" && !("judged_at" in next)) {
    next.judged_at = now;
  }

  return next;
}

function hasExplicitPrimaryKey(table: string, record: Record<string, unknown>) {
  if (!ID_TABLES.has(table) || !Object.prototype.hasOwnProperty.call(record, "id")) {
    return false;
  }

  const normalized = normalizeValue("id", record.id);
  return normalized !== undefined && normalized !== null && normalized !== "";
}

function sqlIdentifier(value: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`SQL 标识符无效：${value}`);
  }
  return `"${value}"`;
}

function parseSelectedColumns(columns: string) {
  const trimmed = columns.trim();
  if (!trimmed || trimmed === "*") {
    return null;
  }

  return trimmed
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean)
    .map((column) => {
      if (column === "*") {
        throw new Error("字段选择不能混用 * 和具体字段。");
      }
      return column;
    });
}

function uniqueError(error: unknown): QueryError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    code: /unique/i.test(message) ? "23505" : undefined,
  };
}

class D1QueryBuilder<T = unknown> implements PromiseLike<QueryResult<T>> {
  private operation: "select" | "insert" | "update" | "delete" = "select";
  private filters: Filter[] = [];
  private orderBys: OrderBy[] = [];
  private maxRows: number | null = null;
  private selectedColumns: string[] | null = null;
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private conflictColumns: string[] = [];
  private ignoreDuplicates = false;
  private singleMode: "none" | "single" | "maybeSingle" = "none";

  constructor(private readonly db: D1Database | null, private readonly table: string) {}

  select(columns = "*") {
    if (this.operation === "select") {
      this.operation = "select";
    }
    this.selectedColumns = parseSelectedColumns(columns);
    return this;
  }

  insert(payload: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.operation = "insert";
    this.payload = payload;
    this.conflictColumns =
      options?.onConflict
        ?.split(",")
        .map((column) => column.trim())
        .filter(Boolean) ?? [];
    this.ignoreDuplicates = options?.ignoreDuplicates ?? false;
    return this;
  }

  update(payload: Record<string, unknown>) {
    this.operation = "update";
    this.payload = payload;
    return this;
  }

  upsert(payload: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string }) {
    this.operation = "insert";
    this.payload = payload;
    this.conflictColumns =
      options?.onConflict
        ?.split(",")
        .map((column) => column.trim())
        .filter(Boolean) ?? [];
    this.ignoreDuplicates = false;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  is(column: string, value: null) {
    this.filters.push({ kind: "is", column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBys.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(value: number) {
    this.maxRows = value;
    return this;
  }

  single<U = T>() {
    this.singleMode = "single";
    return this as unknown as D1QueryBuilder<U>;
  }

  maybeSingle<U = T>() {
    this.singleMode = "maybeSingle";
    return this as unknown as D1QueryBuilder<U>;
  }

  returns<U>() {
    return this as unknown as D1QueryBuilder<U>;
  }

  then<TResult1 = QueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private whereSql(params: unknown[]) {
    if (this.filters.length === 0) {
      return "";
    }

    const clauses = this.filters.map((filter) => {
      if (filter.kind === "is") {
        return `${sqlIdentifier(filter.column)} IS NULL`;
      }
      params.push(normalizeValue(filter.column, filter.value));
      return `${sqlIdentifier(filter.column)} = ?`;
    });

    return ` WHERE ${clauses.join(" AND ")}`;
  }

  private orderSql() {
    if (this.orderBys.length === 0) {
      return "";
    }

    return ` ORDER BY ${this.orderBys
      .map((orderBy) => `${sqlIdentifier(orderBy.column)} ${orderBy.ascending ? "ASC" : "DESC"}`)
      .join(", ")}`;
  }

  private limitSql() {
    return this.maxRows == null ? "" : ` LIMIT ${Math.max(0, Math.floor(this.maxRows))}`;
  }

  private async execute(): Promise<QueryResult<T>> {
    if (!this.db) {
      return { data: null, error: { message: "游戏数据库绑定不可用，请检查本地开发服务配置。" } };
    }

    try {
      if (this.operation === "select") {
        return await this.executeSelect();
      }
      if (this.operation === "insert") {
        return await this.executeInsert();
      }
      if (this.operation === "update") {
        return await this.executeUpdate();
      }
      return await this.executeDelete();
    } catch (error) {
      return { data: null, error: uniqueError(error) };
    }
  }

  private shapeRows(rows: Record<string, unknown>[]): QueryResult<T> {
    const data = rows.map((row) => denormalizeRow(row));

    if (this.singleMode === "single") {
      if (data.length !== 1) {
        return { data: null, error: { message: `${this.table} 查询结果异常：预期 1 行，实际 ${data.length} 行。` } };
      }
      return { data: data[0] as T, error: null };
    }

    if (this.singleMode === "maybeSingle") {
      if (data.length > 1) {
        return { data: null, error: { message: `${this.table} 查询结果异常：预期最多 1 行，实际 ${data.length} 行。` } };
      }
      return { data: (data[0] as T) ?? null, error: null };
    }

    return { data: data as T, error: null };
  }

  private async executeSelect(): Promise<QueryResult<T>> {
    const params: unknown[] = [];
    const selectedColumns = this.selectedSql();
    const sql = `SELECT ${selectedColumns} FROM ${sqlIdentifier(this.table)}${this.whereSql(params)}${this.orderSql()}${this.limitSql()}`;
    const result = await this.db!.prepare(sql).bind(...params).all<Record<string, unknown>>();
    return this.shapeRows(result.results ?? []);
  }

  private selectedSql() {
    return this.selectedColumns?.length ? this.selectedColumns.map(sqlIdentifier).join(", ") : "*";
  }

  private async executeInsert(): Promise<QueryResult<T>> {
    const records = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
    const cleanedRecords = records.map((record) => cleanRecord(this.table, record));
    if (cleanedRecords.length === 0) {
      return this.shapeRows([]);
    }

    const rows: Record<string, unknown>[] = [];
    const columns = Object.keys(cleanedRecords[0]);
    const explicitPrimaryKeyByIndex = records.map((record) => hasExplicitPrimaryKey(this.table, record));
    const canUseBulkInsert = cleanedRecords.every((record, index) => {
      const recordColumns = Object.keys(record);
      return (
        explicitPrimaryKeyByIndex[index] === explicitPrimaryKeyByIndex[0] &&
        recordColumns.length === columns.length &&
        columns.every((column) => Object.prototype.hasOwnProperty.call(record, column))
      );
    });

    if (canUseBulkInsert && cleanedRecords.length > 1) {
      const values = cleanedRecords.flatMap((record) => columns.map((column) => record[column]));
      const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
      const placeholders = cleanedRecords.map(() => rowPlaceholder).join(", ");
      const updateGeneratedId = explicitPrimaryKeyByIndex[0];
      const updateColumns = columns.filter(
        (column) => !this.conflictColumns.includes(column) && (column !== "id" || updateGeneratedId),
      );
      const conflict =
        this.conflictColumns.length > 0
          ? ` ON CONFLICT (${this.conflictColumns.map(sqlIdentifier).join(", ")}) ${
              this.ignoreDuplicates || updateColumns.length === 0
                ? "DO NOTHING"
                : `DO UPDATE SET ${updateColumns
                    .map((column) => `${sqlIdentifier(column)} = excluded.${sqlIdentifier(column)}`)
                    .join(", ")}`
            }`
          : "";
      const sql = `INSERT INTO ${sqlIdentifier(this.table)} (${columns
        .map(sqlIdentifier)
        .join(", ")}) VALUES ${placeholders}${conflict} RETURNING ${this.selectedSql()}`;
      const result = await this.db!.prepare(sql).bind(...values).all<Record<string, unknown>>();
      return this.shapeRows(result.results ?? []);
    }

    for (let index = 0; index < records.length; index += 1) {
      const rawRecord = records[index];
      const updateGeneratedId = hasExplicitPrimaryKey(this.table, rawRecord);
      const record = cleanedRecords[index];
      const recordColumns = Object.keys(record);
      const values = recordColumns.map((column) => record[column]);
      const placeholders = recordColumns.map(() => "?").join(", ");
      const updateColumns = recordColumns.filter(
        (column) => !this.conflictColumns.includes(column) && (column !== "id" || updateGeneratedId),
      );
      const conflict =
        this.conflictColumns.length > 0
          ? ` ON CONFLICT (${this.conflictColumns.map(sqlIdentifier).join(", ")}) ${
              this.ignoreDuplicates || updateColumns.length === 0
                ? "DO NOTHING"
                : `DO UPDATE SET ${updateColumns
                    .map((column) => `${sqlIdentifier(column)} = excluded.${sqlIdentifier(column)}`)
                    .join(", ")}`
            }`
          : "";
      const sql = `INSERT INTO ${sqlIdentifier(this.table)} (${recordColumns
        .map(sqlIdentifier)
        .join(", ")}) VALUES (${placeholders})${conflict} RETURNING ${this.selectedSql()}`;
      const result = await this.db!.prepare(sql).bind(...values).first<Record<string, unknown>>();
      if (result) {
        rows.push(result);
      }
    }

    return this.shapeRows(rows);
  }

  private async executeUpdate(): Promise<QueryResult<T>> {
    const record = cleanRecord(this.table, (this.payload ?? {}) as Record<string, unknown>);
    delete record.id;
    delete record.created_at;

    if (Object.keys(record).length === 0) {
      return { data: null, error: { message: `${this.table} 更新失败：没有可更新的字段。` } };
    }

    const params = Object.entries(record).map(([, value]) => value);
    const sql = `UPDATE ${sqlIdentifier(this.table)} SET ${Object.keys(record)
      .map((column) => `${sqlIdentifier(column)} = ?`)
      .join(", ")}${this.whereSql(params)} RETURNING ${this.selectedSql()}`;
    const result = await this.db!.prepare(sql).bind(...params).all<Record<string, unknown>>();
    return this.shapeRows(result.results ?? []);
  }

  private async executeDelete(): Promise<QueryResult<T>> {
    const params: unknown[] = [];
    const sql = `DELETE FROM ${sqlIdentifier(this.table)}${this.whereSql(params)} RETURNING ${this.selectedSql()}`;
    const result = await this.db!.prepare(sql).bind(...params).all<Record<string, unknown>>();
    return this.shapeRows(result.results ?? []);
  }
}

export function createD1QueryClient(db: D1Database | null) {
  return {
    hasDatabase() {
      return Boolean(db);
    },
    from(table: string) {
      return new D1QueryBuilder(db, table);
    },
  };
}
