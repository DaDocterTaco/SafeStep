# Build and load SafeStep 0.8.6

This source checkpoint corresponds to `stage-8-c028a8deb799`. The [reference](docs/checkpoints/stage-8-c028a8deb799/reference.json) identifies the exact inputs and compiled outputs. Independent results on 0.8.1 and 0.8.4 refer to those earlier builds.

## Clean build

Use Node 24 and npm 11. From the repository root on Windows, run the following commands.

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
node --test tests/stage8-paid-ledger-fixture.test.mjs
npm.cmd run build
npm.cmd run release:stage8
node scripts/stage8-reference.mjs stage-8-c028a8deb799
```

The release command prints the unpacked directory and its SHA-256. Expect `c028a8deb799368a196c384d00ddae7be31d973a93d6fd815222332bd3c244be`. The reference command measures the source inventory, compiled API, compiled contracts and chat routing schema. It writes its result under `docs/evidence/stage-8-c028a8deb799/`. The published reference includes the expected digest of each measured file.

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked** and select `artifacts/stage-8-c028a8deb799/chrome-mv3`. Invoke SafeStep from the toolbar on a site you choose. Use `npm.cmd run fixture -- --port=0` in a second terminal for the labeled local practice pages. The fixture command prints their URLs.

## Local service and optional providers

For the loopback API without Gemini, run `npm.cmd run api` in a local development environment with provider credentials unset. The server creates a short-lived local pairing token. Pair in SafeStep Settings if the selected feature needs the API.

Optional server configuration uses `GEMINI_API_KEY` and `GEMINI_MODEL` for Gemini, and `WEB_RISK_API_KEY`, `SAFESTEP_WEB_RISK_AUTHORIZED` and `SAFESTEP_WEB_RISK_DAILY_LIMIT` for the Web Risk service. The guarded model start command is `npm.cmd run api:with-model` and requires the operator's separately configured spending controls. Building, running fixture tests and comparing fingerprints require no provider credentials. Real provider validation belongs to a separately authorized session. [Environment example](apps/api/.env.example) · [Web Risk setup](docs/automatic-web-risk-setup.md)

The included native Chrome drivers are for explicitly scoped browser runs. Some historical replay drivers use records from the team's private QA workspace. The current checkout supports the development checks above.
