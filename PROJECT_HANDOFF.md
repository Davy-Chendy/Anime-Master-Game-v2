# Project Handoff

Current architecture:

- Frontend: React UI built by Vite and deployed to Cloudflare Pages from `pages-dist`
- Backend: Cloudflare Worker RPC and WebSocket endpoints
- Realtime: Durable Object topics, with room actions sent over WebSocket first
- Persistence: Cloudflare D1
- Image storage: Cloudflare R2 through the Worker `IMAGE_BUCKET` binding

Key files:

- `src/lib/cloudflareRooms.ts`: frontend room/question/game access layer.
- `src/lib/cloudflareClient.ts`: HTTP RPC, WebSocket action ack, fallback, and topic subscriptions.
- `src/lib/r2Upload.ts`: browser image compression and upload through the Worker R2 endpoint.
- `src/main.tsx`, `src/App.tsx`, `src/lib/router.ts`: static Pages entry and browser router for the existing page UI.
- `worker/index.ts`: Worker routes, Durable Object WebSocket handling, broadcasts, and action ack.
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
