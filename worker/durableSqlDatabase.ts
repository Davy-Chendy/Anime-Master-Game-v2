import type { GameDatabase, GamePreparedStatement } from "./d1QueryCompat";

type SqlRow = Record<string, SqlStorageValue>;

class DurableSqlStatement implements GamePreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly sql: SqlStorage, private readonly query: string) {}

  bind(...values: unknown[]) {
    const statement = new DurableSqlStatement(this.sql, this.query);
    statement.values = values;
    return statement;
  }

  async all<T = Record<string, unknown>>() {
    const results = this.sql.exec<SqlRow>(this.query, ...this.values).toArray() as unknown as T[];
    return { results };
  }

  async first<T = Record<string, unknown>>() {
    const row = this.sql.exec<SqlRow>(this.query, ...this.values).toArray()[0];
    return (row as unknown as T | undefined) ?? null;
  }

  executeRows<T = Record<string, unknown>>() {
    return this.sql.exec<SqlRow>(this.query, ...this.values).toArray() as unknown as T[];
  }
}

export class DurableSqlDatabase implements GameDatabase {
  readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
  }

  prepare(query: string) {
    return new DurableSqlStatement(this.sql, query);
  }

  async batch<T = Record<string, unknown>>(statements: GamePreparedStatement[]) {
    return this.storage.transactionSync(() =>
      statements.map((statement) => ({ results: (statement as DurableSqlStatement).executeRows<T>() })),
    );
  }
}
