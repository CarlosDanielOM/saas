# dimadb

Internal Redis/Dragonfly console. One container: Angular CSR on `/`, Node API on `/api`.

NPM: point the host at container `dimadb`, port `80`, network `web-proxy`. No host ports.

```bash
cp .env.example .env
docker compose up -d --build
```

Mock screens: `/login`, `/setup`, `/browse`, `/console`, `/connections`, `/account`.
