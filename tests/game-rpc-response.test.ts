import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOUDFLARE_DAILY_LIMIT_ERROR_CODE,
  CLOUDFLARE_DAILY_LIMIT_MESSAGE,
  GameRpcError,
  readGameRpcResponse,
} from "../src/lib/gameRpcResponse";

async function expectRpcError(response: Response) {
  try {
    await readGameRpcResponse(response);
  } catch (error) {
    assert.ok(error instanceof GameRpcError);
    return error;
  }
  assert.fail("expected readGameRpcResponse to reject");
}

test("HTTP 429 is reported as an exhausted Cloudflare daily limit", async () => {
  const error = await expectRpcError(new Response("<html>Too Many Requests</html>", { status: 429 }));

  assert.equal(error.message, CLOUDFLARE_DAILY_LIMIT_MESSAGE);
  assert.equal(error.code, CLOUDFLARE_DAILY_LIMIT_ERROR_CODE);
  assert.equal(error.status, 429);
});

test("a non-JSON Cloudflare error 1027 page is reported as an exhausted daily limit", async () => {
  const error = await expectRpcError(new Response(
    "<html><title>Error 1027</title><body>Cloudflare Ray ID: example</body></html>",
    { status: 500 },
  ));

  assert.equal(error.message, CLOUDFLARE_DAILY_LIMIT_MESSAGE);
  assert.equal(error.code, CLOUDFLARE_DAILY_LIMIT_ERROR_CODE);
  assert.equal(error.status, 500);
});

test("an ordinary non-JSON server failure keeps the generic invalid-response error", async () => {
  const error = await expectRpcError(new Response("<html>Bad gateway</html>", { status: 502 }));

  assert.equal(error.message, "游戏服务响应异常，请稍后重试。");
  assert.equal(error.code, "INVALID_RESPONSE");
  assert.equal(error.status, 502);
});

test("normal JSON success and business-error payloads are unchanged", async () => {
  const success = await readGameRpcResponse<{ roomId: string }>(Response.json({
    data: { roomId: "room-1" },
  }));
  const businessError = await readGameRpcResponse(Response.json(
    { error: "房间不存在", code: "ROOM_NOT_FOUND" },
    { status: 404 },
  ));

  assert.deepEqual(success.data, { roomId: "room-1" });
  assert.equal(businessError.error, "房间不存在");
  assert.equal(businessError.code, "ROOM_NOT_FOUND");
});
