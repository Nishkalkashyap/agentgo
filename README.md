# AgentGo

Run Codex and Claude Code on your computer from a remote MCP client. The local daemon owns the runs, stores their output in SQLite, and exposes short authenticated MCP requests through Cloudflare Tunnel.

Both providers always use **automatic approval**:

- Codex: `approvalPolicy: "on-request"`, `approvalsReviewer: "auto_review"`, workspace-write sandbox.
- Claude Code: `--permission-mode auto --permission-prompts none`.

There is no approval-policy tool argument. Native automatic reviewers may reject an action. Interactive questions cannot be answered in v1; unsupported interactive requests fail explicitly. Auto approval does not mean bypassing all permissions.

## Requirements

- macOS or Linux, Node.js **24.13+** (uses built-in `node:sqlite`, currently emitting an experimental warning).
- A locally installed and logged-in `codex`, `claude`, or both. Verified with Codex **0.160.1** and Claude Code **2.1.291**; incompatible protocol or permission behavior fails rather than falling back to bypass mode.
- `rg` for glob/search, and `cloudflared` for internet hosting.
- A remote client supporting MCP over HTTP with a custom Authorization header.

## Setup

From this checkout:

```sh
npm ci
npm run build
node dist/cli.js doctor
node dist/cli.js workspace add my-project /absolute/path/to/my-project
node dist/cli.js start --quick
```

`start` prints the MCP URL and a bearer token. Configure your remote client with:

```text
URL: <mcpConnectionURL from start>
Authorization: Bearer <token from start>
```

The daemon runs in the background. Quick Tunnel URLs change after restart/reconnection. For a stable address on a domain you own:

```sh
node dist/cli.js stop
node dist/cli.js start --custom-domain-with-cf agents.example.com
```

The custom-domain command uses cloudflared login if needed, creates/reuses a named tunnel, and adds DNS without overwriting an existing record. An existing dashboard tunnel is also supported:

```sh
node dist/cli.js start --tunnel-token-file /private/path/tunnel-token \
  --hostname agents.example.com --port 8765
```

Configure that dashboard tunnel's origin as `http://127.0.0.1:8765`. Alternatively, `start --local` serves loopback HTTP with no tunnel. If cloudflared is missing, install it yourself or pass `--yes` to approve download of a checksum-verified official release. Use `--no-download` to require an installed binary.

```sh
node dist/cli.js status
node dist/cli.js restart
node dist/cli.js token rotate
node dist/cli.js stop
```

Token rotation takes effect on the next HTTP request. `status` does not reveal the token. Workspace and configuration changes require restarting the daemon. Shutdown interrupts active work; it does not undo edits. Tunnel failure only restarts the tunnel, leaving runs alive.

Use `--state-dir /private/path` or `AGENTGO_HOME` to select a state directory (default `~/.agentgo`). Give separate instances separate state directories. A runtime lock prevents a daemon and a stdio server from sharing a database. Keep the state directory separate from approved workspaces; overlapping workspace roots are rejected.

## Tools

| Tool | Purpose |
| --- | --- |
| `getAgentCapabilities` | CLI versions, availability, fixed approval behavior |
| `getSupportedModels` | Per-model efforts and service tiers; refreshable Codex runtime catalog |
| `listWorkspaces` | Locally registered workspace IDs |
| `listDirectory` | Paginated directory entries |
| `readFile` | Bounded text with line selection |
| `globFiles` | Glob matching over non-ignored files |
| `grepFiles` | Ripgrep search with file names and line numbers |
| `startAgentRun` | Start durable background work |
| `getAgentRunStatus` | State, activity time, configuration, usage and errors |
| `getAgentRunOutput` | Cursor-based visible messages, tools, changes and final response |
| `listAgentRuns` | Find tasks across reconnects, with filtering and pagination |
| `cancelAgentRun` | Request termination of a task and its owned process group |
| `continueAgentSession` | New task in a previously created provider conversation |

Example MCP arguments:

```json
{
  "provider": "codex",
  "model": "gpt-6.1-sol",
  "effort": "high",
  "serviceTier": "priority",
  "workspaceId": "my-project",
  "cwd": ".",
  "prompt": "Fix the failing tests and explain your changes.",
  "idempotencyKey": "task-123",
  "limits": { "wallTimeSeconds": 1800 }
}
```

Discover current model/effort/tier values first. Model access depends on the installed CLI and account. Unknown combinations fail explicitly. For Claude omit `serviceTier`; Claude fast mode is not treated as Codex priority.

Retry the exact same request with the same idempotency key after a connection failure. Reusing a key for different arguments is an error. Keys cover both start and continuation operations and remain reserved after output retention expires.

`taskId` identifies one invocation; `sessionId` identifies the conversation. Continue with:

```json
{
  "sessionId": "<sessionId from start>",
  "prompt": "Now add coverage for the bug you fixed.",
  "idempotencyKey": "task-123-followup"
}
```

Continuation preserves provider, model, effort, tier and working directory. It requires the previous task to finish and a native session ID to have been recorded. Independent workspaces can run concurrently; runs within one workspace are serialized to avoid simultaneous edits.

States are `queued`, `starting`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out`, and `interrupted`. `succeeded` means the provider reported successful completion, not that tests or code are necessarily correct. Cancellation is asynchronous: poll until terminal. The last activity time is not a progress percentage.

Output is paginated with `nextCursor` and `moreAvailable`. Final output may be truncated and says so. Codex usage is explicitly labeled as session cumulative usage, with the last model-response breakdown when available. Claude usage/cost retains provider-reported semantics. Unknown effective settings remain `null`, distinct from requested values.

## Model configuration

Codex discovery uses the installed CLI's app-server catalog and caches it for five minutes. `refresh: true` refreshes it without starting paid inference.

Claude's catalog is locally configured and labeled `source: configured`, `availability: unverified`. It starts with the `sonnet` and `opus` CLI aliases and low/medium/high efforts. The actual resolved model is reported when a run starts. Add a model/effort combination supported by your installation:

```sh
node dist/cli.js model add claude-sonnet-5-5 --efforts low,medium,high,xhigh,max
node dist/cli.js restart
```

`~/.agentgo/config.json` also accepts `codexPath`, `claudePath`, `rgPath`, `maxConcurrentRuns` (default 2), `maxQueuedRuns` (100), `maxRunSeconds` (3600), `maxRunOutputBytes` (10 MiB), and `retentionDays` (30). Use `config show` to inspect defaults. Executable paths and workspace roots are local configuration only, never remote tool inputs.

## Local stdio and TypeScript client

An MCP client on the same machine can launch:

```json
{
  "mcpServers": {
    "local-agents": {
      "command": "node",
      "args": ["/absolute/path/to/agentgo/dist/cli.js", "stdio"]
    }
  }
}
```

Do not run stdio and the HTTP daemon with the same state directory. Stdio EOF interrupts active tasks and closes the service.

```ts
import { connectAgent } from 'agentgo';

const client = await connectAgent({
  mcpConnectionURL: process.env.AGENTGO_URL!,
  token: process.env.AGENTGO_TOKEN!,
});
try {
  const models = await client.getSupportedModels('codex');
  const workspaces = await client.listWorkspaces();
  // All tools are also available through the typed client.call(name, arguments).
  const listing = await client.call('listDirectory', {
    workspaceId: workspaces.workspaces[0]!.id,
    path: '.',
  });
} finally {
  await client.close();
}
```

This is a local package, not yet published. `npm pack` creates an installable tarball; install it in your client project to use the package import. The package also exports the service, HTTP/stdio MCP servers, and hosting helpers.

## Access and recovery behavior

The HTTP server binds to loopback. Cloudflared provides public HTTPS; application bearer authentication remains mandatory. Cloudflare carries the traffic. Host/Origin validation, request limits and rate limits apply. Local daemon controls use an owner-only Unix socket that is never routed through the HTTP endpoint.

Directory/read/search tools reject traversal, symlink traversal, sensitive credential paths, special files and oversized files. Search respects ignore files, including `.gitignore` outside Git repositories. Searches have explicit file/byte/result limits and report truncation. Directory listing can show a symlink entry but cannot follow it.

**Workspace checks constrain direct browsing and initial working directories. They are not a security sandbox for agent shell execution.** Codex retains its workspace-write sandbox plus native automatic approval review; Claude retains its native auto-mode controls. Both run under your local account and use its provider configuration, trusted project instructions, hooks, plugins and tools. Register trusted projects and give the bearer token only to clients authorized to launch coding agents as you. Separate OS identities or containers are needed for hostile users or untrusted repositories.

Hosting credentials are not inherited by agent subprocesses. Only selected shell/provider environment variables are passed. Hidden reasoning and raw provider debug logs are not exposed as run events. Visible agent output can contain information from files it reads; this server does not claim to scrub every possible secret from arbitrary agent output.

Run state and events are durable SQLite records. After a crash, incomplete work becomes `interrupted` and is not replayed automatically. A guardian process terminates the owned process group when the daemon connection disappears. This covers ordinary CLI descendants; a deliberately detached process can escape a process group. Resume a known session explicitly after checking any partial changes.

Old output and prompts expire after `retentionDays`. Compact task/session metadata and idempotency records remain so a late retry cannot repeat work. Native CLI histories have their own retention and are not deleted by this server. Queue and output limits bound concurrent work; exceeding the output limit stops that run with an explicit error.

## Development and verification

```sh
npm test
npm run typecheck
npm pack --dry-run
```

Tests use fake provider binaries and cover MCP HTTP/stdio, auth, token rotation, filesystem restrictions, session resume, idempotency, cancellation, timeouts, malformed output, daemon recovery and tunnel restart. They do not call paid models or alter Cloudflare configuration.

Opt-in smoke tests:

```sh
npm run smoke:providers -- codex
npm run smoke:providers -- claude
npm run smoke:tunnel
```

Provider smoke tests perform two small real model turns in a temporary workspace, verifying a file edit and session memory. They incur normal provider usage. The tunnel smoke starts a temporary Quick Tunnel and verifies remote authenticated MCP, then stops it. It exposes only an empty temporary workspace and does not run an agent. A named tunnel/DNS setup requires your domain and is not exercised by these tests.

OAuth, interactive steering/approval input, multi-machine routing, worktree orchestration and Windows process supervision are not part of v1.

## License

MIT. Cloudflare/storage helpers and portions of HTTP hosting are adapted from PrintGo; see `NOTICE` and `LICENSE`.
