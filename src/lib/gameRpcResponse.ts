export const CLOUDFLARE_DAILY_LIMIT_ERROR_CODE = "CLOUDFLARE_DAILY_LIMIT";
export const CLOUDFLARE_DAILY_LIMIT_MESSAGE =
  "服务器日额度已耗尽，请于北京时间 08:00 额度重置后重试。";

export class GameRpcError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GameRpcError";
  }
}

export type GameRpcResponsePayload<T> = {
  data?: T;
  error?: string;
  code?: string;
  authoritySequence?: {
    gameId: string;
    actorId: string;
    committedSeq: number;
  };
};

function containsCloudflareError1027(body: string) {
  return /\berror(?:\s+code)?\s*[:：-]?\s*1027\b/i.test(body)
    || /\bcloudflare\b[\s\S]{0,500}\b1027\b/i.test(body)
    || /\b1027\b[\s\S]{0,500}\bcloudflare\b/i.test(body);
}

export async function readGameRpcResponse<T>(response: Response): Promise<GameRpcResponsePayload<T>> {
  const body = await response.text();

  if (response.status === 429 || (!response.ok && containsCloudflareError1027(body))) {
    throw new GameRpcError(
      CLOUDFLARE_DAILY_LIMIT_MESSAGE,
      CLOUDFLARE_DAILY_LIMIT_ERROR_CODE,
      response.status,
    );
  }

  let payload: GameRpcResponsePayload<T> | null = null;
  try {
    payload = JSON.parse(body) as GameRpcResponsePayload<T> | null;
  } catch {
    // Cloudflare error pages and upstream failures can return HTML instead of JSON.
  }

  if (!payload) {
    throw new GameRpcError(
      "游戏服务响应异常，请稍后重试。",
      "INVALID_RESPONSE",
      response.status,
    );
  }

  return payload;
}
