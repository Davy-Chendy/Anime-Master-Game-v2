import type { ConnectionPresenceChange } from "@/types/game";

export const CONNECTION_DISCONNECTED_GRACE_MS = 60_000;

export function applyConnectionPresenceChanges(
  current: Record<string, number>,
  changes: ConnectionPresenceChange[],
  replace = false,
): Record<string, number> {
  const next = replace ? {} : { ...current };
  for (const change of changes) {
    if (change.disconnectedAt == null) delete next[change.playerId];
    else next[change.playerId] = change.disconnectedAt;
  }
  return next;
}

export function isConnectionDisconnected(disconnectedAt: number | undefined, now = Date.now()): boolean {
  return disconnectedAt != null && now >= disconnectedAt + CONNECTION_DISCONNECTED_GRACE_MS;
}
