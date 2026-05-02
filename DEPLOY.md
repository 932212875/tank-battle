# Deployment

This project has two deployable parts:

- The Vite frontend can be deployed to Netlify.
- The WebSocket game server in `server/server.ts` must run on a host that supports long-lived Node.js WebSocket processes.

## Frontend on Netlify

Netlify uses `netlify.toml`:

- Build command: `npm run build`
- Publish directory: `dist`

Set this environment variable in Netlify before deploying production:

```text
VITE_WS_URL=wss://your-hosted-websocket-server.example.com
```

Without `VITE_WS_URL`, the browser falls back to `ws://<frontend-host>:8080`, which is useful locally but not correct for a Netlify production deploy.

## WebSocket Backend

Deploy `server/server.ts` to a Node host that supports WebSockets and long-running processes, then set `VITE_WS_URL` to that service's public `wss://` URL.

The backend start command is:

```bash
npm install
npm run start
```

The server reads `PORT` from the environment and defaults to `8080`.

## Local Development

```bash
npm install
npm run dev
```

The frontend runs through Vite and the backend runs locally on port `8080`.
