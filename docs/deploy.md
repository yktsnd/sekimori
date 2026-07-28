# Deploying sekimori

This page is written for an agent operator first (deterministic commands,
expected output, exit codes) and is readable by a human second. It documents
**only what has actually been executed against the packaged tarball** — the
same npm artifact a `npm install sekimori` user gets, not the source tree.
Docker was not available in the environment that produced this rehearsal (no
daemon); everything below runs sekimori as a plain OS process, which is also
what most non-Docker hosting platforms (a VPS, a systemd unit, a platform's
"run this binary" service) do.

A **hosted** HTTPS deployment (Fly.io, Railway, a VPS behind a reverse
proxy, ...) needs an owner's real hosting account and credentials and has
**not** been executed yet — see [GitHub issue #9](https://github.com/yktsnd/sekimori/issues/9)
and "Not yet verified" below. Do not present any part of that section as
tested.

## Requirements

- **Node.js >= 20** (the packaged `engines.node` requirement). Verify with
  `node --version` on the target host before installing.
- **HTTPS termination in front of sekimori — never expose it over plain
  HTTP on a public network.** sekimori itself does not terminate TLS; put a
  platform's built-in HTTPS/load balancer or a reverse proxy (nginx, Caddy,
  the hosting platform's edge) in front of it. Plain HTTP is accepted by
  sekimori's own config validation only for exact `localhost` or a literal
  loopback address (see [configuration.md](configuration.md#network-exposure)).
- **`listenHost`**: keep the default `127.0.0.1` when a reverse proxy on the
  *same host* forwards to sekimori. Set `--listen-host 0.0.0.0` (IPv4) or
  `::` (IPv6) only when the platform's proxy/load balancer reaches sekimori
  over the network rather than localhost — and only once HTTPS termination
  and a firewall/platform access policy are in front of it. Always read the
  `[sekimori] listening on ...` startup log line before handing a URL to
  anyone; it prints the actual bound address.
- **A persistent volume for the file store.** With `store.type: "file"`
  (the recommended production setting), sekimori writes `<store.path>` and a
  same-directory `<store.path>.lock` for the process lifetime. Both files —
  and the directory that holds them — must live on storage that survives a
  redeploy/restart (a platform's persistent/durable volume, not an ephemeral
  container filesystem that resets on redeploy). Losing that directory loses
  all issued tokens and budget history.
- **Env-var injection through the platform's secret store.** Never write
  `ANTHROPIC_API_KEY` / `AWS_BEARER_TOKEN_BEDROCK` or `SEKIMORI_ADMIN_KEY`
  into the config file, a Dockerfile, or a repository. Every platform this
  project expects to target (Fly.io secrets, Railway variables, a systemd
  `EnvironmentFile`, ...) has an equivalent "environment variable" / "secret"
  setting — use it.
- **Single-process constraint.** sekimori keeps rate limiting, active-request
  counting, and (for the file store) an exclusive lock in one process. Do
  not run multiple replicas or put it behind a load balancer that fans out
  to more than one instance — see [design.md](design.md) and AGENTS.md rule 6.

## Verified in this repository

Executed end to end against the packaged tarball, as real OS processes, no
Docker, no real provider credentials (the mock upstream in
[`examples/mock-upstream.mjs`](../examples/mock-upstream.mjs) stands in for
`api.anthropic.com`). Commands are abbreviated for readability; exact flags
match `sekimori init --help`.

### 1. Pack and install into a fresh project

```bash
npm pack --pack-destination /path/to/scratch          # -> sekimori-0.2.0.tgz, exit 0
mkdir /path/to/fresh-project && cd /path/to/fresh-project
npm init -y
npm install /path/to/scratch/sekimori-0.2.0.tgz        # exit 0
./node_modules/.bin/sekimori --version                 # -> 0.2.0
```

Observed: tarball built and installed cleanly; the installed bin shim ran
and reported the correct version.

### 2. Start the mock upstream (stands in for the real Anthropic API)

```bash
node examples/mock-upstream.mjs 19999
# [mock-upstream] listening on http://127.0.0.1:19999 (Anthropic Messages API stub)
```

### 3. Non-interactive config generation

```bash
sekimori init --yes \
  --port 18787 \
  --upstream-url http://127.0.0.1:19999 \
  --store file --store-path /path/to/state/state.json \
  --monthly-usd 5 --daily-usd 1 \
  sek.json
# exit 0; "[sekimori init] wrote /path/to/fresh-project/sek.json"
```

### 4. `doctor` before boot, with real strong secrets exported

```bash
export SEKIMORI_ADMIN_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
export ANTHROPIC_API_KEY="sk-ant-<a real or, for rehearsal, a realistic placeholder key>"
sekimori doctor sek.json --json
```

Observed (secrets never appear in the output):

```json
{"ok":true,"checks":[
  {"name":"config_file","status":"ok","detail":"found and readable: sek.json"},
  {"name":"config_valid","status":"ok","detail":"parses as JSON and passes validateConfig"},
  {"name":"upstream_key_env","status":"ok","detail":"ANTHROPIC_API_KEY is set"},
  {"name":"admin_key_env","status":"ok","detail":"SEKIMORI_ADMIN_KEY is set"},
  {"name":"store_writable","status":"ok","detail":"store directory is writable: /path/to/state"},
  {"name":"logging","status":"ok","detail":"request/response body logging is disabled"}
]}
```

Exit code `0`, as expected before any state file exists.

### 5. Boot, token issue, gateway round trip, usage, and the 401 guard

```bash
sekimori sek.json &
curl -fsS http://127.0.0.1:18787/healthz
# {"ok":true}

curl -s -X POST http://127.0.0.1:18787/admin/tokens \
  -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"deploy-rehearsal"}'
# HTTP 201, {"id":"...","token":"smk_...", ...}

curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18787/v1/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}'
# 200

curl -fsS http://127.0.0.1:18787/v1/usage -H "Authorization: Bearer $TOKEN"
# {"todayUsd":0.00009,"dailyLimitUsd":1}

curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18787/v1/messages \
  -H 'Content-Type: application/json' -d '{}'
# 401 (no Authorization header)
```

Observed exactly this: `/healthz` `200`, admin token issued, the Messages
round trip through the mock upstream returned `200` with a real response
body, `/v1/usage` reflected the incurred cost, and the tokenless probe
returned `401`.

### 6. Graceful restart (SIGTERM — a normal platform redeploy)

```bash
kill -TERM <sekimori-pid>
```

Observed server log: `[sekimori] SIGTERM received; shutting down`, then the
process exited on its own within the timeout (well under the 10-second
forced-exit fallback in `main.ts`). The lock file
(`<store.path>.lock`) was **not** present after the graceful exit. Starting
sekimori again against the same `sek.json` succeeded immediately, and
`/v1/usage` for the same token returned the identical `todayUsd` as before
the restart — **budget state is preserved across a graceful restart.**

### 7. File permissions and state location

```
state/
├── state.json        # -rw------- (0600)
└── state.json.lock    # -rw------- (0600), only while a process owns it
```

`sek.json` (the config file `init` writes) is also `0600`. None of these
files ever contain the upstream or admin secret — those are environment
variables only. `state.json` itself contains token metadata (SHA-256
hashes, not the plaintext invite tokens) and per-day USD usage — treat the
whole state directory as sensitive operational data and keep it off any
public path, even though it is not itself a credential.

## Crash recovery (SIGKILL / OOM kill)

**Read this before you deploy — this is the most likely way a deployed
instance stays down after an incident, so it gets its own section.**

### What was executed

```bash
kill -9 <sekimori-pid>            # simulates an OOM kill / platform force-restart
sekimori sek.json                 # attempt to restart against the same store.path
```

### Exact observed result

The restart attempt **exited non-zero (exit code 1)** and printed exactly:

```
[sekimori] fatal error: Error: file store is already locked: /path/to/state/state.json.lock (if the prior process was hard-killed, verify it is stopped before removing this stale lock)
    at Object.acquireLock (.../dist/store.js:...)
    at async FileStore.init (.../dist/store.js:...)
    at async runServe (.../dist/main.js:...)
    at async run (.../dist/main.js:...)
```

This matches [design.md](design.md)'s documented decision exactly: a
`SIGKILL` gives the process no chance to run its `SIGINT`/`SIGTERM` cleanup,
so `<store.path>.lock` is left on disk with the dead process's PID inside it,
and **sekimori deliberately refuses to start with a leftover lock** rather
than silently risking a second writer against the same state file.

### `doctor` detects this (issue #27)

An earlier rehearsal of this same scenario found that `sekimori doctor
sek.json --json` reported `"ok": true` with `store_writable: "ok"` while the
stale lock above was still present — a false all-clear while the server
actually could not boot. That gap is now closed: `store_writable` inspects
the adjacent `<store.path>.lock` (existence + whether its recorded pid is
alive, via the same `process.kill(pid, 0)` check the codebase already uses
elsewhere) **without ever taking the lock itself**, so it never disturbs a
live process. Re-running the exact scenario above against the packaged
tarball's `dist` confirms it:

```bash
sekimori doctor sek.json --json
```

```json
{"ok":false,"checks":[
  {"name":"config_file","status":"ok","detail":"found and readable: sek.json"},
  {"name":"config_valid","status":"ok","detail":"parses as JSON and passes validateConfig"},
  {"name":"upstream_key_env","status":"ok","detail":"ANTHROPIC_API_KEY is set"},
  {"name":"admin_key_env","status":"ok","detail":"SEKIMORI_ADMIN_KEY is set"},
  {"name":"store_writable","status":"fail","detail":"store file is valid and writable: /path/to/state/state.json; stale lock: /path/to/state/state.json.lock names a process that is no longer running. Startup will refuse to boot while this file exists (see docs/deploy.md#crash-recovery-sigkill--oom-kill: confirm no sekimori process still owns it, then remove only the .lock file - never the state file)."},
  {"name":"logging","status":"ok","detail":"request/response body logging is disabled"}
]}
```

Exit code `1`, matching the startup refusal above. The reverse case was also
verified: running `doctor` **while sekimori is still up** (lock held by the
live process) reports `store_writable: "ok"` and exit `0`, as it must — that
is the normal, healthy state of a running instance, not a fault. A lock file
that cannot be read or does not contain a usable pid is `warn`, not a false
`ok` or `fail`, since liveness genuinely cannot be determined from it. The
lock file's own contents (pid, nonce, timestamp) are never printed in either
case — only its path, in both human and `--json` output. See
[configuration.md](configuration.md#sekimori-doctor--installation-self-check)
for the full check-table entry.

### Recovery procedure (exactly what was executed and verified)

1. **Confirm the old process is actually gone.** Read the PID sekimori
   itself recorded in the lock file, and check whether that PID is alive:
   ```bash
   node -e "console.log(JSON.parse(require('fs').readFileSync('state/state.json.lock','utf8')).pid)"
   ps -p <that-pid>          # "no such process" confirms the crash
   ```
   Also confirm no sekimori process is using that exact state path by
   process listing (`ps aux | grep 'sekimori'` or your platform's process
   list), matching the config path, not just the string `sekimori` — an
   unrelated process can coincidentally match. **If a live sekimori process
   still owns the lock, stop that process — never delete a live owner's
   lock to create a second replica** (AGENTS.md rule 6).
2. **Remove only the lock file, never the state file:**
   ```bash
   rm -f state/state.json.lock
   ```
3. **Restart** sekimori against the same config/store path.

Observed: the restart succeeded immediately, `/healthz` returned `200`
again, and `/v1/usage` for the token issued before the crash returned the
**identical** accumulated `todayUsd` — the already-recorded budget debit
survives the crash exactly as design.md describes ("state replacement uses
... atomic rename ... these are single-host crash-safety measures"); nothing
was lost or double-counted.

### Practical implication for a hosting platform

If your platform's health check restarts a crashed sekimori automatically,
**expect the automatic restart to keep failing** until something removes the
stale lock — the process will not recover on its own. An operator (or the
agent operating it) must run the three-step procedure above by hand, or via
a small platform-specific startup script that performs step 1's liveness
check before step 2's `rm`. Do not add an automatic "always delete the lock
before starting" step to a startup script — that would defeat the exact
protection this refusal exists for (two live processes writing the same
state file).

## Not yet verified

The following have **not been executed** — do not treat any of this as
tested, and do not let a reader believe otherwise:

- **Any managed hosting platform** (Fly.io, Railway, a VPS behind a
  reverse proxy such as nginx/Caddy, or any other host). No account,
  credential, HTTPS certificate, or platform-specific persistent-volume
  configuration has been exercised.
- **A real upstream provider call** (Anthropic direct or Amazon Bedrock).
  Every round trip above went through the offline mock upstream in
  `examples/mock-upstream.mjs`; no real API key was used, and no real spend
  occurred.
- **Multi-day / multi-month accounting behavior in a long-running hosted
  process** (UTC-midnight daily reset, UTC-month-boundary compaction) —
  covered by unit tests (`npm test`), not by this rehearsal, which ran for
  minutes.
- **Log access, rollback, and secret rotation on a real platform.**

This is exactly the scope of
[GitHub issue #9](https://github.com/yktsnd/sekimori/issues/9): a hosted
HTTPS deployment is credential-gated on the owner supplying a real hosting
account, a real provider key through that host's secret manager, and
explicit budget approval. Until that issue is executed and its evidence
recorded, do not write or imply platform-specific hosting recipes (Fly.io
`fly.toml` snippets, Railway configs, systemd units, nginx/Caddy configs,
...) as verified — RELEASING.md's release gate requires exactly that
distinction.
