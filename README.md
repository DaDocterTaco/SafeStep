# SafeStep · Stage 2

SafeStep is a Chrome MV3 extension that guides two public tasks, one user click at a time. Its native side panel also compares current and suggested addresses with a known website. Both features run locally without an account, API key or server.

**Stage 2 build for independent testing** · `stage-2-490d7abfc3ce`, SHA-256 `490d7abfc3cefa3ea7feb6ddee51b205980893e61a0580d7297d884a1d94a870`. See the [builder’s checks](docs/STAGE_2_BUILD_REPORT.json), [feature status](docs/feature-status.json), [site coverage](docs/supported-sites.md) and [source access inventory](docs/source-access.md). Evidence paths in the builder report refer to the team’s local records.

During independent testing, requests for Firefox and the Moon landing selected the VLC and Phishing guides respectively. The two supported requests are described below.

## Try the verified build

1. From a clean checkout with Node 24 and npm 11, run `npm ci`, `npm run build` and `npm run release:stage2`. The last command prints the unpacked path and fingerprint. In `chrome://extensions`, disable any older unpacked copy, enable **Developer mode**, choose **Load unpacked**, and select `artifacts/stage-2-490d7abfc3ce/chrome-mv3` when the printed fingerprint matches the one above.
2. Open [Wikipedia: Phishing](https://en.wikipedia.org/wiki/Phishing) and click **SafeStep** in Chrome’s toolbar. Type “Help me find the APA citation for this article.” and press **Help me**, or choose the task from the picker. Click the highlighted Tools, Cite this page and APA controls. Completion requires the Phishing citation view and its visible APA section.
3. On [VideoLAN](https://www.videolan.org/), invoke the toolbar action again for access to that site. Enter “Help me find VLC for Windows.” Follow VLC → Download → Windows. Use **Show me** if the outlined control is off-screen. Stop on the Windows information page, before the installer button.
4. For local examples, run `npm run fixture` and open [the harmless address lab](http://localhost:4174/addresses) or [the practice desk](http://localhost:4174/). Click the toolbar action on that tab. In **Check page and link addresses**, select the expected site, click **Inspect addresses**, then choose a link. Nothing fetches the link's destination. **Manual page inspector** still lets you outline individual controls.
5. To check external-source readiness, start `npm run api` in a separate terminal. Open **Sources & coverage → Check local service** in the panel, or visit [the health endpoint](http://127.0.0.1:4317/health). Inspection works even when the API is stopped. No key is necessary; all six provider interfaces are unavailable until an entitled connector is implemented and verified.
6. **Access & preferences → Enable on this site** opens Chrome’s permission prompt. Declining leaves temporary toolbar access intact. Granting allows future visits on the selected origin; removal pauses related tasks. **Restore page** removes the extension outline. **Clear SafeStep data** resets SafeStep’s tasks, site selections and text-size preference across tabs.

To stop either local service, press Ctrl+C in its terminal. If PowerShell blocks npm’s script shim, use `npm.cmd` for the commands above.

## Develop and verify

| Command from the root | Purpose |
| --- | --- |
| `npm run dev` | Start WXT’s development watcher. Load `apps/extension/.output/chrome-mv3-dev` manually while it runs. For shared-contract edits, run `npm run contracts` before reloading. |
| `npm run typecheck` | Compile shared contracts, generate WXT types and type-check the extension and API. |
| `npm test` | Run the message, task, registry, evidence and loopback HTTP boundary tests, including an actual timeout. |
| `npm run build` | Compile the API to `apps/api/dist` and the production unpacked extension to `apps/extension/.output/chrome-mv3`. |
| `npm run release:stage2` | Freeze the Stage 2 extension in its own fingerprinted directory, preserving earlier builds. |
| `npm run test:chrome` | Exercise the production extension in an isolated installed Google Chrome profile. The test starts its own fixture and API; stop a manual API first so port 4317 is free. |
| `npm run test:chrome:f03` | Repeat the 95-second idle highlight and first re-selection at both QA desktop sizes in isolated Chrome profiles. |
| `npm run test:chrome:stage2` | Run both live public workflows at both desktop sizes, plus local address, idle, mutation, recovery, keyboard and cancellation fixtures. |

The full Chrome test uses Windows UI Automation to answer native permission prompts **only in its own disposable Chrome process**. It uses a headed browser, a private DevTools pipe, an ephemeral loopback fixture port and a temporary profile, which it removes after closing Chrome. `CHROME_PATH` can override the executable. The default test target is the production build directory. To test this same frozen release in PowerShell:

```powershell
$env:SAFESTEP_BUNDLE = 'artifacts/stage-2-490d7abfc3ce/chrome-mv3'
npm.cmd run test:chrome:stage2
npm.cmd run test:chrome
npm.cmd run test:chrome:f03
```

The harness asserts Chrome’s actual `SIDE_PANEL` context, uses the toolbar action and native panel controls, delays selected messages in the disposable worker for race tests, kills the worker, reloads the installed extension, and restarts Chrome with the same profile. It leaves fresh screenshots and a JSON result in `.test-artifacts/`. This is builder integration evidence; the dedicated tester’s acceptance run and human usability studies are separate.

## Components and data boundaries

- `apps/extension/entrypoints/` wires the React side panel, MV3 service worker and an on-demand isolated-world bridge. `core/` binds messages to the active tab, window, Chrome document ID, revision and task generation. Checkpoints are in trusted session storage; preferences use trusted local storage.
- `apps/extension/page/` reads at most 32 controls, skips private fields and frames, masks unknown URL path segments, and keeps temporary element references only in the live document. Navigation, target changes, revocation, pause and cancellation invalidate earlier work. A lost worker re-inspects and pauses; it cannot replay a page action.
- `packages/contracts/` defines versioned, validated messages and document-bound snapshots. An explicit reveal scrolls without activating a target. No page-script RPC or automatic navigation executor is present.
- `apps/extension/features/` retains all nine modules. `sites/` contains the two supported adapters, local intent rules and address parsing with pinned public-suffix data. A matching domain is not a safety verdict.
- `apps/api/` is a loopback-only TypeScript service with six provider boundaries. Its optional credentials belong in `apps/api/.env` (see `.env.example`) or the API process environment. No provider keys belong in WXT environment variables or the browser bundle.

The [seven-stage roadmap](RESEARCH_STATE.json) retains the remaining seven features. Stage 3 (website trust and download protection) is the next development milestone after Stage 2 testing.

## External code

The dependency lockfile records the third-party packages. WXT and Vite build the MV3 bundle; React renders the panel, Zod validates shared contracts, TypeScript compiles the project, and Puppeteer Core drives Chrome during builder tests. The fixtures, task coordinator, inspection/highlight bridge, provider boundary, test harness and panel were implemented in this workspace with Codex assistance. No third-party reviews or private website data are bundled.
