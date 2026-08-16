# DSH Beacon

**DSH Beacon** is a desktop management tool for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It gives you a visual beacon for the health and state of your DSH installation:

- Overview
- Plugins
- Skills
- MCP Servers
- Profiles
- Doctor
- Settings / Snapshots
- Plugin Marketplace

## Name

The project was originally named *DSH-Orbit* in the PRD. The user asked for a new folder/name that is innovative and easy to use, without overlapping existing names. **Beacon** was chosen: a beacon is small, memorable, and instantly signals status/health — exactly what this desktop tool does.

## Requirements

- Node.js 20+
- npm
- macOS or Windows
- Optional: `dsh` CLI installed (`dsh --version`)

## Development

```bash
npm install --include=dev   # install runtime + dev dependencies
npm run typecheck
npm run build
npm start                   # launch Electron
```

> Note: if your npm is configured with `omit=dev`, use `--include=dev`.

## Verification

```bash
npm run verify
```

This runs typecheck, build, and the complete test suite. Tests use a temporary `DSH_HOME` and never modify your real `~/.dsh` unless you explicitly run an install action from the UI.

## Architecture

```
src/
  core/        DSH detection, profiles, safe config transactions, snapshots
  mcp/         MCP manager (JSON import, manual config, test connection)
  skills/      Skill scanner (DSH skill-filesystem rules), installer
  plugins/     Official `dsh plugin` wrapper + bundle toggling
  doctor/      Environment checks
  marketplace/ PluginRegistry abstraction + sample registry
  main/        Electron main process + IPC
  preload/     Context-isolated preload API
  renderer/    DOM-based renderer
scripts/       Verification scripts
```

## Safety

All configuration writes go through the same pipeline:

```
Read → Parse → Backup → Modify → Validate → Atomic Write → Health Check
```

Every successful modification records a snapshot (kept 10) and can be restored from **Settings → Snapshots**.
