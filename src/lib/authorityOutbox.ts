"use client";

export type AuthorityOutboxItem = {
  actionId: string;
  topic: string;
  actorId: string;
  clientSeq: number;
  gameId: string;
  questionIndex: number;
  name: string;
  payload: Record<string, unknown>;
  args: unknown[];
  createdAt: number;
};

const DATABASE_NAME = "anime-master-authority";
const DATABASE_VERSION = 1;
const OUTBOX_STORE = "outbox";
const META_STORE = "meta";
let databasePromise: Promise<IDBDatabase> | null = null;

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败。"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 事务已中止。"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 事务失败。"));
  });
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = database.createObjectStore(OUTBOX_STORE, { keyPath: "actionId" });
        store.createIndex("topic", "topic", { unique: false });
      }
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("无法打开实时操作 Outbox。"));
    };
  });
  return databasePromise;
}

export async function enqueueAuthorityMutation(input: Omit<AuthorityOutboxItem, "actionId" | "clientSeq" | "createdAt">) {
  const database = await openDatabase();
  const transaction = database.transaction([OUTBOX_STORE, META_STORE], "readwrite");
  const outbox = transaction.objectStore(OUTBOX_STORE);
  const meta = transaction.objectStore(META_STORE);
  const sequenceKey = `seq:${input.gameId}:${input.actorId}`;
  const previous = Number(await requestResult(meta.get(sequenceKey))) || 0;
  const clientSeq = previous + 1;
  const actionId = crypto.randomUUID();
  const item: AuthorityOutboxItem = { ...input, actionId, clientSeq, createdAt: Date.now() };
  meta.put(clientSeq, sequenceKey);
  outbox.put(item);
  await transactionDone(transaction);
  return item;
}

export async function syncAuthoritySequence(gameId: string, actorId: string, committedSeq: number) {
  const database = await openDatabase();
  const transaction = database.transaction(META_STORE, "readwrite");
  const store = transaction.objectStore(META_STORE);
  const key = `seq:${gameId}:${actorId}`;
  const current = Number(await requestResult(store.get(key))) || 0;
  if (committedSeq > current) store.put(committedSeq, key);
  await transactionDone(transaction);
}

export async function listAuthorityOutbox(topic: string) {
  const database = await openDatabase();
  const transaction = database.transaction(OUTBOX_STORE, "readonly");
  const items = await requestResult(transaction.objectStore(OUTBOX_STORE).index("topic").getAll(topic)) as AuthorityOutboxItem[];
  await transactionDone(transaction);
  return items.sort((left, right) => left.actorId.localeCompare(right.actorId) || left.clientSeq - right.clientSeq);
}

export async function deleteAuthorityAction(actionId: string) {
  const database = await openDatabase();
  const transaction = database.transaction(OUTBOX_STORE, "readwrite");
  transaction.objectStore(OUTBOX_STORE).delete(actionId);
  await transactionDone(transaction);
}

export async function commitAuthorityOutbox(topic: string, gameId: string | undefined, committedSeqByActor: Record<string, number>) {
  const database = await openDatabase();
  const transaction = database.transaction(OUTBOX_STORE, "readwrite");
  const store = transaction.objectStore(OUTBOX_STORE);
  const items = await requestResult(store.index("topic").getAll(topic)) as AuthorityOutboxItem[];
  for (const item of items) {
    if (gameId && item.gameId !== gameId) continue;
    if (item.clientSeq <= (committedSeqByActor[item.actorId] ?? 0)) store.delete(item.actionId);
  }
  await transactionDone(transaction);
}

export async function discardSupersededAuthorityOutbox(topic: string, currentGameId: string) {
  const database = await openDatabase();
  const transaction = database.transaction(OUTBOX_STORE, "readwrite");
  const store = transaction.objectStore(OUTBOX_STORE);
  const items = await requestResult(store.index("topic").getAll(topic)) as AuthorityOutboxItem[];
  for (const item of items) {
    if (item.gameId !== currentGameId) store.delete(item.actionId);
  }
  await transactionDone(transaction);
}

export async function resetAuthorityOutboxForTests() {
  const database = databasePromise ? await databasePromise : null;
  database?.close();
  databasePromise = null;
  await requestResult(indexedDB.deleteDatabase(DATABASE_NAME));
}
