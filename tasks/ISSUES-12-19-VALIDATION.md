# Terminal lifecycle: issues 12 and 19

Baseline: main at `1c72f8bf9c1352520e7036d84bd7518e99992d82`.
Both issues stay open until operator validation is complete.

## Behavior

- Switching tabs and collapsing the drawer preserve terminal instances and PTYs.
- New processes use authenticated `POST /api/terminal/sessions`. WebSockets only attach.
  A missing process is never restarted by reconnect.
- Reconnect replaces displayed replay with a bounded snapshot. Replay is not a durable recording.
- Five automatic reconnect attempts precede manual retry.
- Explicit stop verifies local Linux process-tree completion. It does not cancel work delegated to Docker.
- Graceful shutdown stops local PTYs and flushes exit-log writes. PTYs do not survive server restart.
- Failed bootstrap update output stays in its mounted viewer until dismissal or retry. It is not a durable update log.
- Auth expiry/revocation disconnects terminal viewers within approximately five seconds without killing jobs.
- Every authenticated viewer remains a full operator. There is no per-user isolation.

## Configuration

Set these in the dashboard process/container environment. The launcher does not automatically forward exported variables; use explicit container environment or custom Compose configuration.

| Variable | Default | Meaning |
| --- | --- | --- |
| TERMINAL_MAX_SESSIONS | 32 | Running and retained exited identities |
| TERMINAL_MAX_VIEWERS | 8 | Viewers per process |
| TERMINAL_OUTPUT_CHARS | 500000 | Default shell replay cap |
| TERMINAL_TOTAL_OUTPUT_CHARS | 32000000 | Global replay cap |
| TERMINAL_IDLE_MS | 0 | Detached inactivity timeout; zero disables |
| TERMINAL_LIFETIME_MS | 0 | Absolute process lifetime; zero disables |
| AUTH_IDLE_MS | 43200000 | Twelve-hour idle authentication lifetime |
| AUTH_ABSOLUTE_MS | 604800000 | Seven-day absolute authentication lifetime |
| AUTH_MAX_SESSIONS | 256 | Least-recently-used token eviction at capacity |

Caps count UTF-16 characters, not bytes. Builds/bootstrap request up to five million characters per run. Global replay eviction discards oldest-session output without killing the process. Exited terminal identities/output remain for five minutes. Fallback logs are capped at 32 entries and 20 million characters with seven-day retention, pruned on log operations. Disk-log cleanup runs during listing. Auth pruning runs during creation/validation. HTTP polling counts as auth activity; terminal heartbeats do not renew idle auth. Non-browser HTTP writes must send the exact trusted Origin.

## Automated validation

Use Node 22 and installed project dependencies:

```bash
npm run check
npm run lint
npm run test:unit -- --run
npm run build
npm run build:server
npm run test:deployment
npm run test:gateway
node --test scripts/tests/auth-state.test.mjs
node --experimental-strip-types --test scripts/tests/terminal-processes.test.mjs
npm run test:production
npm run test:e2e
```

Playwright uses the compiled custom server, not Vite preview. Use disposable fixtures only.

## Operator acceptance

Record exact commit, image, browser, and HTTPS URL.

1. Open A/B/C. Select each with real pointer clicks and run distinct harmless commands. Verify focus and input/output isolation.
2. Switch rapidly during slow initialization. Move focus to another dashboard control. Check that late initialization cannot steal focus.
3. Resize, maximize/restore, and collapse/reopen. Close the newest and selected tabs. Verify focus, scrollback, and process identity.
4. Disconnect and restore the network. Verify connection states, snapshot replay, automatic retry limits, and manual retry. The PID must stay unchanged.
5. Reload and attach from a second browser. Verify simultaneous viewers.
6. Stop disposable commands with descendants. Verify all local PIDs stop; do not infer Docker cancellation.
7. Restart the dashboard during reconnect. The old command must not rerun. Starting again requires an explicit new session.
8. Test logout and short auth lifetimes in a disposable instance. Viewers detach but background jobs continue.
9. Fail a bootstrap update. Inspect output, refresh status, retry, and dismiss. Test ordinary bootstrap/build cancellation too.
10. Exercise session/viewer/output limits and repeated log-write failures.
11. Send SIGTERM/SIGINT with running jobs, with and without Tailscale mode. Verify cleanup and retained failure logs.
12. Through the real HTTPS URL, test terminal reconnect and existing Supervisor/noVNC/OpenCode gateways, including service login.

## Evidence so far

Local Node 22 Linux process-tree tests: two passed (graceful termination and escalation). The isolated auth-state TypeScript regression test passed after restoring the explicit AuthState annotation. Svelte compiler 5.55.2 parsed the three changed components; a non-reactive retry-handler warning was identified and corrected locally.

These are focused checks, not an application build or acceptance pass. The initial draft CI failed; source integration and formatting corrections are still in progress. No production, Docker, browser E2E, or real Tailscale pass is claimed. Axel owns the end-to-end validation. Do not add automatic issue-closing keywords before acceptance.
