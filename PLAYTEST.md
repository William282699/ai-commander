# AI Commander — Playtest Deploy Guide

How to let friends play through one URL.

The frontend used to hardcode `http://localhost:3001` for API calls, which
breaks the moment another machine opens the page. This doc covers the
single-URL setup where one Express server serves both the React SPA and
the `/api/*` routes.

---

## Local development (unchanged)

Still two processes, two ports:

```bash
# terminal 1 — Express backend (LLM, TTS proxy)
npm run dev:server          # http://localhost:3001

# terminal 2 — Vite frontend (HMR, dev tools)
npm run dev                 # http://localhost:3000
```

The frontend's `API_URL` (see `apps/web/src/api.ts`) picks up `DEV` mode
and points at `http://localhost:3001` automatically. Nothing to configure.

---

## Single-URL playtest (one process, same origin)

Build the SPA, then have Express serve both static files and `/api/*`:

```bash
# Build the frontend bundle into apps/web/dist/
npm run build

# Start the server in production mode
NODE_ENV=production npm run start --workspace=apps/server

# OR the one-shot helper added in this commit:
npm run start:prod
```

Open `http://localhost:3001` — you should see the game. All API calls now
go to the same origin (`/api/...` relative paths), so anyone who opens the
URL hits the same server you're running.

### Sanity check

```bash
curl -s http://localhost:3001/api/health | head -c 200
# → {"status":"ok","time":...,"llmConfigured":true}
```

If `llmConfigured: false`, check `apps/server/.env`.

---

## Exposing publicly — Cloudflare Tunnel (recommended for ad-hoc playtests)

Free, no account-side container build, takes ~30 seconds. Cloudflare gives
you a `*.trycloudflare.com` URL that points at your local server.

```bash
# Install cloudflared once (Homebrew on macOS)
brew install cloudflared

# Start your prod server first (separate terminal)
npm run start:prod

# Open the tunnel — copy the printed https://*.trycloudflare.com URL
cloudflared tunnel --url http://localhost:3001
```

Send that URL to friends. Stop the tunnel (`Ctrl+C`) and the URL dies.

### ngrok alternative

```bash
ngrok http 3001
# https://abcd1234.ngrok-free.app
```

Both tunnels work identically because the SPA uses relative `/api/...`
paths now — no client config needed per tunnel URL.

---

## Cloud deploy (Render / Railway / Fly)

These platforms run one process, expose one port. Same shape as the
single-URL setup above.

**Build command**
```
npm install && npm run build
```

**Start command**
```
npm run start --workspace=apps/server
```
(Use this, not `npm run start:prod`, because the platform runs the build
step separately.)

**Health check path**: `/api/health`

**Environment variables** (set in platform dashboard):

| Key | Example | Notes |
|---|---|---|
| `NODE_ENV` | `production` | enables the PLAYTEST gate logic |
| `PORT` | (auto) | Render/Railway inject this; Express reads `process.env.PORT` |
| `PLAYTEST_ENABLED` | `true` or `false` | `false` shows maintenance page |
| `GEMINI_API_KEY` | `<your key>` | **server-only**, never prefix with `VITE_` |
| `LLM_PROFILE` | `gemini-2.5-flash` | overrides default DeepSeek mapping |
| `VITE_API_URL` | (omit) | only needed if you split front/back onto different hosts |

⚠️ **Never put `GEMINI_API_KEY` (or any LLM key) under a `VITE_*` name.**
Vite inlines every `VITE_*` env var into the public bundle. Anyone with
DevTools can read it.

---

## PLAYTEST_ENABLED kill switch

Set in your deployment environment:

```
NODE_ENV=production
PLAYTEST_ENABLED=false
```

Then:
- `GET /` → 503 with an HTML maintenance page
- `POST /api/*` → 503 JSON `{ "error": "playtest closed" }`

The gate is evaluated **once at server startup**. To flip it, change the
env var and restart the process.

`NODE_ENV !== "production"` always passes through, so `npm run dev:server`
is never affected.

---

## TODO: access code gating

Not implemented yet. The plan:

- Env var `PLAYTEST_CODE=somevalue`
- First visit must use `?code=somevalue`
- On match, set `playtest_ok=1` cookie; subsequent visits don't need the code

Tracked in `apps/server/src/index.ts` (search `TODO(playtest)`).

---

## Troubleshooting

**"AI Commander server running on http://localhost:3001" but blank page**
→ Did you run `npm run build` first? The `apps/web/dist/` directory must
exist. Check `[boot] static SPA dir:` in server logs — that path should
contain `index.html`.

**Tunnel URL works but API calls fail in DevTools**
→ Open DevTools → Network and confirm the request path is `/api/...`
(relative), not `http://localhost:3001/...`. If it's the latter, the
prod bundle wasn't rebuilt after the API_URL refactor — run `npm run build`
again. Hard-refresh the browser to bust the cache.

**Friend's audio doesn't play**
→ Edge TTS goes server → friend's browser as MP3. The browser may block
autoplay until first user gesture; click anywhere on the page once.

**Maintenance page shows but you didn't ask for it**
→ Check both `NODE_ENV` and `PLAYTEST_ENABLED`. Gate only triggers when
**both** `NODE_ENV === "production"` AND `PLAYTEST_ENABLED === "false"`.
