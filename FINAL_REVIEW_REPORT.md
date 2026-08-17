# Final Review Report — DSH Desktop Hub (Windows port)

**Phase:** Consensus · **Date:** post-adversarial-review
**Scope:** Windows-port audit of `dsh-desktop` (renderer, harness, dsh runtime bundling, NSIS packaging, CI)

## Review disposition

- **12 findings survived** adversarial review and are listed below.
- **0 findings were discarded at the consensus stage** — every finding that reached consensus survived.
- Note: candidates discarded *during* the adversarial phase are not carried in the surviving-findings input, so that earlier count cannot be reconstructed from this phase's data and is not stated here.
- Voting: 9 findings survived unanimously (2/2); 3 survived with one dissenting vote (1/2, marked †) — the dissenting concern was re-checked and the finding retained.

## Surviving findings

### P0 — Critical

**1. WHITE-SCREEN ROOT CAUSE STILL PRESENT: invalid `file://` URL on Windows** (`src/main/main.ts:45`)
`RENDERER_URL = \`file://${RENDERER_HTML}\`` produces `file://C:\...` on Windows (colon in host + backslashes); empirically reproduced with the repo's own Electron 43.4.0 — main frame `did-fail-load code=-300 ERR_INVALID_URL`. macOS starts with `/` so it worked there, which is exactly why the bug shipped. The shell renderer never runs → the harness iframe never mounts → explains **both** reported symptoms (white screen AND "spinning for minutes"). Affects product mode, `--smoke` and `--harness-smoke`. Same bug in `scripts/capture-demo.mjs:14`.
**Fix:** `import { pathToFileURL } from 'node:url'`; `const RENDERER_URL = pathToFileURL(RENDERER_HTML).href` (→ `file:///C:/...`). `isAllowedNavigation` regex and sender/`shellWebContents` string comparisons stay consistent automatically.

### P1 — High

**2. CI/verification gap: Windows release job can never catch a renderer load failure**
`.github/workflows/release.yml` (`release-windows`) only runs `npm run verify`; `scripts/verify.mjs` checks file existence, build, typecheck and node tests but never launches Electron. `--smoke`/`--harness-smoke` are never executed in CI, so the P0 bug and any future Windows renderer regression ship silently.
**Fix:** add a Windows smoke step (`npx electron . --smoke` with hard timeout; smoke already asserts 4 tabs + panel loads and exits non-zero on main-frame `did-fail-load` via `src/main/smoke.ts`) plus a `did-fail-load` diagnostic dump of the main log into job artifacts.

**3. "Never connects" diagnosability hole — URL printed only after loader settle; plugin-load failure exits before printing** †
Evidence: `dsh-web-app/lib/index.js` gates `printUrl` on `ctx.get('loader')?.await()`, and the failure callback is empty (`() => {}`); `dsh/lib/profile-boot-*.js` `installFailLoud` → `proc.exit(1)`. The shell then waits the full 180 s readyTimeout, and `scheduleAutoRestart` retries 5× with 3/6/12/24/48 s backoff → a persistently failing harness shows "连接中" for ~15 min with no reason.
**Fix:** in `harness.ts`, scan dsh stderr for the `dsh: fatal load failure:` marker and reject immediately with that text; include the last ~10 dsh log lines in `HarnessStatus.error` so the UI shows the real cause.

**4. Installer path-length risk (>260 MAX_PATH)**
Deepest packaged file is 208 chars relative (`resources/app.asar.unpacked/.../opentelemetry/.../getMachineId-unsupported.js`); under `%LOCALAPPDATA%\Programs\DSH Desktop Hub\` (~60 chars) the absolute path is ~270 chars. Runtime access is safe (libuv/Chromium use `\\?\`), but NSIS/nsis7z extraction and non-long-path-aware Win32 calls can fail on Windows 10/11 without `longPathsEnabled`.
**Fix:** verify installer extraction on a default-policy clean VM; if it fails, trim duplicate nested `@opentelemetry` copies in `scripts/bundle-runtime.mjs` or ship an `nsis.include` enabling long-path awareness.

### P2 — Medium

**5. NSIS payload (built on macOS) flattens POSIX `.bin` symlinks into regular files** †
Verified in the actual installer via `7zz l` of `release/DSH-Desktop-Hub-0.1.0-x64.exe` → `$PLUGINSDIR/app-64.7z`: `.bin\dsh` = 8274 B (== `lib/bin.js`), `.bin/pnpm` = 1464 B, `.bin/cordis` = 388 B, all regular files. `dsh plugin` is safe (spawns `pnpm` with `shell:true` → cmd → PATHEXT → `.cmd` shim; shims are correct and node is on PATH). **But** any `shell:false` bare-name spawn can pick the extensionless file first — most importantly MCP stdio servers (`StdioClientTransport` spawns `command` verbatim, e.g. `npx`) with `resources/node`'s extensionless POSIX `npm`/`npx` in PATH. libuv PATHEXT search order with both variants present must be verified on real Windows.
**Fix:** verify on hardware; recommend `cmd /c npx ...` for MCP stdio rows on Windows (or strip extensionless entries from packaged `.bin`/node dirs).

**6. `src/core/plugins.ts` runPluginOp Windows defects**
(a) `spawn()` lacks `windowsHide: true` → console window flashes on every `dsh plugin add/remove/update` (harness.ts sets it; runPluginOp does not). (b) `cancel()`/`child.kill('SIGTERM')` kills only the direct node.exe child — the `cmd /c pnpm` subtree (spawnSync `shell:true` in dsh) survives, keeps running pnpm and holds the profile's node_modules lock → next plugin op fails with lock/EBUSY.
**Fix:** add `windowsHide:true`; on cancel run `taskkill /pid <pid> /T` (mirroring `harness.ts` taskkillTree) or spawn cancel through stopTree semantics.

**7. Quit-during-startup orphans the harness**
`app.on('will-quit')` only stops `harness`, assigned after `startHarnessAndWatch` resolves; if the user quits while `startHarness` is in flight (`detached:true`), the dsh web process survives with no owner (file watchers, session DB on `~/.dsh`), and every future launch adds another orphan — port 0 avoids bind conflicts but the profile is contended.
**Fix:** track the in-flight child in a `startingProc` variable and stopTree it in `will-quit` (also clear `autoRestartTimer` there).

**8. watchHarness auto-restart cap bypassed for crash-after-ready loops**
`autoRestartAttempts = 0` is reset on every successful start, so a harness that reaches ready then crashes (e.g. HMR watcher failure on Windows — `watchUserPatches` failure after boot makes dsh exit 1 per `profile-boot-*.js`) restarts forever via the exit handler, never reaching the 5-attempt give-up.
**Fix:** rate-limit restarts by wall-clock window (max N restarts per 10 min) instead of counting only failed starts.

**9. `atomicWriteWithBackup` (`src/core/mcp.ts`) has no retry around `renameSync`**
Transient EBUSY/EPERM on Windows (Defender real-time scan, HMR watcher on `cordis.patch.yml`) makes MCP/plugin patch writes fail intermittently. dsh's own writer already handles this exact case (`WRITE_RETRY_LIMIT=10` + `retryableWriteError(EACCES/EBUSY/EPERM)` in `dsh-app-boot/lib/index.js`).
**Fix:** add bounded retry (e.g. 10 × 50 ms) around the rename, mirroring dsh.

### P3 — Low

**10. `src/core/log.ts` initLog: `mkdirSync(dir, { recursive: true })` outside any try/catch**
Only `appendFileSync` is guarded. If `~/.dsh-desktop-hub/logs` cannot be created (read-only/redirected home, disk full), the module-level `initLog()` throws and the main process dies before any window — no window at all on machines with an unusual profile.
**Fix:** wrap `mkdirSync` in try/catch (log to stderr on failure) and keep going.

**11. Cross-bundle/trim audit — all items VERIFIED CORRECT (no action)**
Checked with evidence: (1) `npm ci --os=win32 --cpu=x64` works; committed lockfile already contains win32 optional deps (`@img/sharp-win32-x64` at lockfile line 4633) and the shipped payload has sharp-win32-x64 0.35.3 self-contained (libvips-42.dll + `.node`); (2) node-pty `prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node` + `conpty/win10-x64` present and match node-pty's loader; (3) fastlist trim matches reality (`dist/vendor/fastlist-0.3.0-x64.exe` kept, x86 removed); (4) `resources/node/node.exe` is a genuine PE32+ x64 console binary; (5) `!**/*.map` removes 0 non-sourcemap data files (0 `.map` in shipped asar); (6) `!resources/node/*.zip` correctly excludes the zip cache on native CI builds (trim only runs when `RUNTIME_TARGET` is set); (7) `--port 0` is a real web-app flag (`dsh-web-app/lib/startup.js`) and the webserver row binds `127.0.0.1`; (8) dsh prints exactly `dsh web: http://127.0.0.1:<port>` after loader settle and `/` serves 200 via frontend-static fallback — `parseHarnessUrl` + `waitForHttp` match; (9) pwsh/bash rows are platform-gated in `cordis.patch.yml` and pwsh resolution is lazy — no pwsh needed at boot on a clean machine; (10) shell CSP `frame-src http://127.0.0.1:*` permits the harness iframe; renderer mount-on-ready + restart-remount logic is race-free.

**12. "Install was slow" contributing factors (product-level)**
Quantified: 24,525 asar entries + ~317 MB `app.asar.unpacked` + NSIS Deflate-solid + Defender real-time scanning; trim already reduced the installer 208 → 162 MiB (verified: `release/DSH-Desktop-Hub-0.1.0-x64.exe` = 162 MiB, payload `app-64.7z` = 169 MB). Consider `nsis.compression: store`-style tradeoffs or a per-user differential/WebView-style update path if the 30 s install goal must be met. The 30 s **connect** goal is achievable after the P0 fix (first boot ≈ junction creation + local tree activation, all offline), provided Defender doesn't scan the unpacked runtime on first spawn — verify on hardware.

## Priority order for remediation

1. **P0-1** (white screen) — blocks everything; 5-minute fix, unblocks product, `--smoke`, `--harness-smoke`.
2. **P1-2** (CI smoke) — must land with or immediately after the P0 fix so the regression can never re-ship.
3. **P1-3** (diagnosability) — removes the silent ~15 min "连接中" class of failures.
4. **P1-4, P2-6, P2-7, P2-8, P2-9** (installer path length, plugin-op console/lock, quit orphans, restart cap, write retry) — robustness fixes for real Windows usage.
5. **P2-5** (MCP stdio spawn) — needs hardware verification; act on results.
6. **P3-10, P3-12** — low-risk hardening; **P3-11** requires no action.
