import type { ConnectionPresenceChange } from "../src/types/game";

export const CONNECTION_PRESENCE_STORAGE_KEY = "connection-presence:v1";
export const CONNECTION_PRESENCE_BATCH_MS = 150;

type StoredConnectionPresence = {
  version: 1;
  disconnectedAtByPlayerId: Record<string, number>;
};

type PresenceSocketAttachment = {
  topic?: string;
  playerId?: string;
};

function readAttachment(socket: WebSocket): PresenceSocketAttachment | null {
  try {
    const attachment = socket.deserializeAttachment() as PresenceSocketAttachment | null;
    return attachment && typeof attachment === "object" ? attachment : null;
  } catch {
    return null;
  }
}

export class RoomConnectionPresence {
  private disconnectedAtByPlayerId: Map<string, number> | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly pendingDetectedAtByPlayerId = new Map<string, number | null>();
  private readonly closingSockets = new WeakSet<WebSocket>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly topic: () => string | null,
    private readonly broadcast: (changes: ConnectionPresenceChange[]) => void,
    private readonly currentPlayerIds: () => Set<string> | null,
  ) {}

  async handleConnect(playerId: string | undefined): Promise<ConnectionPresenceChange[]> {
    await this.load();
    const snapshot = this.getSnapshot();
    if (playerId) {
      this.pendingDetectedAtByPlayerId.set(playerId, null);
      this.scheduleFlush();
    }
    return snapshot;
  }

  handleDisconnect(socket: WebSocket, detectedAt = Date.now()): void {
    const attachment = readAttachment(socket);
    if (!attachment?.playerId || !attachment.topic || attachment.topic !== this.topic()) return;
    this.closingSockets.add(socket);
    if (!this.pendingDetectedAtByPlayerId.has(attachment.playerId)) {
      this.pendingDetectedAtByPlayerId.set(attachment.playerId, detectedAt);
    }
    this.scheduleFlush();
  }

  async handleRosterChanged(): Promise<void> {
    await this.load();
    for (const playerId of this.disconnectedAtByPlayerId?.keys() ?? []) {
      if (!this.pendingDetectedAtByPlayerId.has(playerId)) this.pendingDetectedAtByPlayerId.set(playerId, null);
    }
    if (this.pendingDetectedAtByPlayerId.size) this.scheduleFlush();
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushPromise) return this.flushPromise;
    const task = this.flush();
    this.flushPromise = task;
    try {
      await task;
    } finally {
      if (this.flushPromise === task) this.flushPromise = null;
      if (this.pendingDetectedAtByPlayerId.size) this.scheduleFlush();
    }
  }

  private async load(): Promise<void> {
    if (this.disconnectedAtByPlayerId) return;
    if (!this.loadPromise) {
      this.loadPromise = this.state.storage.get<StoredConnectionPresence>(CONNECTION_PRESENCE_STORAGE_KEY)
        .then((stored) => {
          const entries = stored?.version === 1 ? Object.entries(stored.disconnectedAtByPlayerId ?? {}) : [];
          this.disconnectedAtByPlayerId = new Map(entries.filter((entry): entry is [string, number] =>
            Boolean(entry[0]) && typeof entry[1] === "number" && Number.isFinite(entry[1]),
          ));
        })
        .finally(() => { this.loadPromise = null; });
    }
    await this.loadPromise;
  }

  private getSnapshot(): ConnectionPresenceChange[] {
    return Array.from(this.disconnectedAtByPlayerId ?? [], ([playerId, disconnectedAt]) => ({ playerId, disconnectedAt }));
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushPromise) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.state.waitUntil(this.flushNow().catch((error) => {
        console.error(JSON.stringify({ event: "connection_presence_flush_failed", error: String(error) }));
      }));
    }, CONNECTION_PRESENCE_BATCH_MS);
  }

  private async flush(): Promise<void> {
    await this.load();
    const pending = new Map(this.pendingDetectedAtByPlayerId);
    this.pendingDetectedAtByPlayerId.clear();
    if (!pending.size) return;

    const topic = this.topic();
    const connectedPlayerIds = new Set<string>();
    for (const socket of this.state.getWebSockets()) {
      if (this.closingSockets.has(socket)) continue;
      const attachment = readAttachment(socket);
      if (attachment?.topic === topic && attachment.playerId) connectedPlayerIds.add(attachment.playerId);
    }

    const currentPlayerIds = this.currentPlayerIds();
    const changes: ConnectionPresenceChange[] = [];
    const nextState = new Map(this.disconnectedAtByPlayerId!);
    for (const playerId of currentPlayerIds ? Array.from(nextState.keys()) : []) {
      if (!currentPlayerIds!.has(playerId)) {
        nextState.delete(playerId);
        changes.push({ playerId, disconnectedAt: null });
      }
    }
    for (const [playerId, detectedAt] of pending) {
      if (currentPlayerIds && !currentPlayerIds.has(playerId)) continue;
      if (connectedPlayerIds.has(playerId)) {
        if (nextState.delete(playerId)) changes.push({ playerId, disconnectedAt: null });
      } else if (!nextState.has(playerId)) {
        const disconnectedAt = detectedAt ?? Date.now();
        nextState.set(playerId, disconnectedAt);
        changes.push({ playerId, disconnectedAt });
      }
    }
    if (!changes.length) return;

    if (nextState.size) {
      await this.state.storage.put(CONNECTION_PRESENCE_STORAGE_KEY, {
        version: 1,
        disconnectedAtByPlayerId: Object.fromEntries(nextState),
      } satisfies StoredConnectionPresence);
    } else {
      await this.state.storage.delete(CONNECTION_PRESENCE_STORAGE_KEY);
    }
    this.disconnectedAtByPlayerId = nextState;
    this.broadcast(changes);
  }
}
