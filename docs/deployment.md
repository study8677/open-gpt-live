# Deployment

OpenGPT Live runs as two processes:

- the Next.js Web app on port `3000`;
- the HTTP/WebSocket Gateway on port `8787`.

The Gateway owns every provider credential. The Web app only receives the public WebSocket URL.

## Production build

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs type checking, all automated tests, and both production builds.

Start the already-built processes together:

```bash
pnpm start
```

The Gateway requires `OPENAI_API_KEY` in production. Configuration is documented in [configuration.md](configuration.md).

## Health check

```bash
curl http://127.0.0.1:8787/healthz
```

Example response:

```json
{
  "status": "ok",
  "service": "open-gpt-live-gateway",
  "uptimeSeconds": 12,
  "connections": 1,
  "version": "0.2.0",
  "realtimeStt": true,
  "tts": true
}
```

The health check does not call a model provider and does not expose credentials.

## Docker Compose

Create `.env`, then run:

```bash
docker compose up --build
```

This uses `Dockerfile.gateway`, `Dockerfile.web`, and the root `docker-compose.yml`. The example exposes:

- Web: `http://localhost:3000`
- Gateway health: `http://localhost:8787/healthz`
- Gateway WebSocket: `ws://localhost:8787`

`NEXT_PUBLIC_GATEWAY_WS_URL` is compiled into the Web image. Set its Docker build argument to the public `wss://` address when deploying anywhere other than localhost.

## Reverse proxy

Terminate TLS at a reverse proxy and forward WebSocket upgrades to the Gateway. A minimal Nginx shape is:

```nginx
location /voice-gateway/ {
  proxy_pass http://127.0.0.1:8787/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 3600s;
}
```

Build the Web app with:

```dotenv
NEXT_PUBLIC_GATEWAY_WS_URL=wss://your-domain.example/voice-gateway/
```

Set `ALLOWED_ORIGINS` to the exact public Web origins, for example:

```dotenv
ALLOWED_ORIGINS=https://your-domain.example
```

This allowlist checks browser `Origin` headers; it is not authentication. Non-browser WebSocket clients can omit `Origin`, so expose the Gateway behind your own authentication and network controls when the deployment is not public.

## Logs

The Gateway writes one JSON object per line. Events include session connection/disconnection, request completion, Realtime STT fallback, provider failure, and audio size rejection. Logs use `sessionId` and `requestId` for correlation and redact fields whose names look like credentials, audio, transcripts, or message content.

## Production checklist

- Serve the Web app over HTTPS and the Gateway over WSS.
- Keep model credentials in the Gateway environment only.
- Restrict `ALLOWED_ORIGINS`.
- Put the Gateway behind connection and request limits appropriate to the hosting platform.
- Monitor `/healthz`, structured errors, provider latency, and model spend.
- Run the [Live Mode smoke test](live-mode-smoke-test.md) after every deployment.
- Treat the current project as a reference implementation; authentication, billing, and multi-tenant isolation are not included.

## Rollback

Build images from immutable Git commit SHAs. To roll back, redeploy the last known-good Web and Gateway images together, then run the text, push-to-talk, Live Mode, TTS, and barge-in smoke tests.
