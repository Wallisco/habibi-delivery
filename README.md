# Habibi delivery

Two applications and one service.

| | |
|---|---|
| `dispatch-service/` | The engine. Ready gate, dispatch, pricing, back office, Keychat API. |
| `driver-app/` | React Native / Expo. iOS and Android. |

## Start here

- **`dispatch-service/ARCHITECTURE.md`** — how the system fits together and why
- **`dispatch-service/DEPLOY.md`** — step-by-step from GitHub to the app stores
- **`dispatch-service/KEYCHAT_API.md`** — the integration contract for Keychat's developers

## Run it locally

Two terminals.

```bash
cd dispatch-service && npm install && npm test && npm start
```

```bash
cd driver-app && npm install && npx expo start
```

Back office at `http://localhost:3000/ops`.
