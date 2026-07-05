# Project Handoff

Current architecture:

- Frontend: React UI built by Vite and deployed to Cloudflare Pages from `pages-dist`
- Backend: Cloudflare Worker RPC and WebSocket endpoints
- Realtime: Durable Object topics, with room actions and topic-known game reads sent over WebSocket first
- Persistence: Cloudflare D1
- Image storage: Cloudflare R2 through the Worker `IMAGE_BUCKET` binding

Request budget guidance:

- Cloudflare HTTP `Requests` are a constrained resource for this project. Treat every new `/api/rpc` call in an active room as a cost decision, not as a free convenience read.
- In-game actions and reads that already know `roomId` or `gameSessionId` should prefer the existing WebSocket action path in `src/lib/cloudflareClient.ts`; keep HTTP `/api/rpc` for bootstrap, join-by-code, upload/import flows, and fallback.
- When adding a new game RPC, first decide whether it belongs in `MUTATION_NAMES`, `WS_QUERY_NAMES`, or must remain HTTP-only. Topic-known query RPCs should generally be added to `WS_QUERY_NAMES`.
- Preserve safe fallback semantics: mutations must not silently retry over HTTP, and query business errors should surface instead of being hidden by HTTP fallback. Only WebSocket transport failures should fall back for read-only queries.
- Keep structured observability for RPC transport and action names. Use the `game_rpc` logs in Workers Observability to confirm that request-heavy flows are using WebSocket rather than `/api/rpc`.
- Avoid polling and repeated "catch-up" reads in room/game screens. Prefer pushed deltas or a single snapshot read after reconnect/open.

Key files:

- `src/lib/cloudflareRooms.ts`: frontend room/question/game access layer.
- `src/lib/cloudflareClient.ts`: HTTP RPC, WebSocket action ack, query-over-WS routing, fallback, and topic subscriptions.
- `src/lib/r2Upload.ts`: browser image compression and upload through the Worker R2 endpoint.
- `src/main.tsx`, `src/App.tsx`, `src/lib/router.ts`: static Pages entry and browser router for the existing page UI.
- `worker/index.ts`: Worker routes, Durable Object WebSocket handling, broadcasts, action ack, and RPC observability logs.
- `POST /api/r2-upload`, `GET /api/r2-images`, `GET /api/r2-images/*`: Worker-hosted R2 upload, listing, and image serving endpoints.
- `worker/gameService.ts`: migrated game state transition logic running inside the Worker.
- `worker/d1QueryCompat.ts`: D1 query compatibility layer for the migrated service logic.
- `d1/migrations/0001_initial.sql`: D1 schema.
- `wrangler.toml`: Worker, Durable Object, and D1 binding config.

Verification:

```bash
npm run lint
npm run worker:typecheck
npm run build
npx wrangler deploy --dry-run
```

Deployment checklist:

1. `npx wrangler d1 create anime_master_game`
2. Put the generated `database_id` into `wrangler.toml`
3. `npx wrangler r2 bucket create anime-master-game-images`
4. Confirm the `IMAGE_BUCKET` binding in `wrangler.toml`
5. `npm run d1:migrate:remote`
6. `npm run worker:deploy`
7. Set `NEXT_PUBLIC_API_BASE_URL=<Worker URL>` in Cloudflare Pages for cross-origin Worker API, or delete `NEXT_PUBLIC_API_BASE_URL` when using same-origin custom-domain `/api/*`
8. Deploy the frontend build output directory `pages-dist`
