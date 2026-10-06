# AgentGo

AgentGo lets an AI assistant run Codex and Claude Code on your computer. It's
an [MCP](https://modelcontextprotocol.io) server: once your MCP client is
connected to it, the assistant can look around the projects you've allowed,
hand a coding task to Codex or Claude Code, check on it while it works, and
read the result.

AgentGo runs on the computer where your code and your logged-in `codex` and
`claude` CLIs live, and puts itself behind a Cloudflare tunnel, so the
assistant can reach it from anywhere: a cloud agent, your phone, or another
laptop.

**Read this first.** The agents run as you, with your files, your logins and
your git credentials, and they approve their own actions. Anyone who has the
AgentGo password can make them do anything they'd do for you. Only give the
password to clients you'd trust at your keyboard, and only add projects you'd
let an agent loose on.

## Why I built it

I got sick of Codex's remote connection and remote device setup. I never got
it working reliably, and when it did work it was too slow. AgentGo is my
answer to that.

## What you need

- macOS or Linux, with Node.js 24.13 or newer. AgentGo uses Node's built-in
  SQLite, which still prints an "experimental" warning.
- `codex`, `claude`, or both, installed and logged in. AgentGo uses your
  existing logins and never asks for API keys. It's tested with Codex 0.160.1
  and Claude Code 2.1.291.
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on your `PATH`, for
  the file search tools. On macOS: `brew install ripgrep`.
- `cloudflared` for the tunnel. If you don't have it, AgentGo can download it
  for you (see below).
- An MCP client that supports the Streamable HTTP transport and lets you set
  an `Authorization` header.

## Getting started

Install the CLI and check that everything it needs is there:

```sh
npm install -g agentgo-mcp
agentgo doctor
```

This installs two commands, `agentgo` and `agentgo-mcp`. They're the same
thing; this README uses `agentgo`.

`doctor` shows whether `codex`, `claude`, `rg` and `cloudflared` are installed
and whether you're logged in to each agent.

Next, tell AgentGo which projects agents may work in. Each one gets a short ID
that the assistant uses to refer to it:

```sh
agentgo workspace add my-app ~/code/my-app
```

Then start the server:

```sh
agentgo start
```

This starts AgentGo in the background along with a Cloudflare tunnel, then
prints an MCP URL and the header to send with it:

```text
MCP URL:       https://<random-words>.trycloudflare.com/mcp
Header name:   Authorization
Header value:  Bearer <password>
```

Add both to your MCP client. Include the word `Bearer` and the space after it.

The password is created the first time you run `start` and reused after that.
Running `start` again while the server is up just prints it again. To replace
it, run `agentgo token rotate`; the old one stops working straight away.

If `cloudflared` isn't installed, `start` stops and tells you. Install it
yourself (`brew install cloudflared` on macOS), or run `agentgo start --yes` to
let AgentGo download the official release from GitHub and check it against its
published checksum. Pass `--cloudflared <path>` if yours is somewhere unusual.

### Managing the server

```sh
agentgo status
agentgo stop
agentgo restart
```

Workspaces and settings are read when the server starts, so restart it after
changing them. Stopping the server interrupts any runs in progress. Edits they
already made stay, but nothing is undone or resumed automatically.

If the server won't start, its log is at `~/.agentgo/daemon.log`.

Add `--json` to any command if you're calling it from a script. The password
is in the `token` field.

### A stable address

By default you get a Cloudflare Quick Tunnel. It needs no Cloudflare account,
but its URL changes every time the tunnel starts or reconnects. If you have a
domain on Cloudflare, you can use a fixed address instead:

```sh
agentgo stop
agentgo start --custom-domain-with-cf agents.example.com
```

If `cloudflared` isn't logged in to your Cloudflare account yet, this opens a
browser so you can log in. AgentGo then creates a tunnel in your account (or
reuses the one it made before) and adds a DNS record for the hostname. It
won't overwrite a DNS record that already exists.

If you'd rather manage the tunnel in the Cloudflare dashboard, point its
public hostname at `http://127.0.0.1:8765`, save the tunnel token to a file,
and run:

```sh
agentgo start --tunnel-token-file ~/tunnel-token --hostname agents.example.com --port 8765
```

`start` remembers how it was last started, so later `start` and `restart`
calls reuse the same tunnel. Pass `--quick` to go back to a Quick Tunnel, or
`--local` to listen on `127.0.0.1` with no tunnel at all.

If the tunnel drops, AgentGo reconnects it in the background. Runs in progress
aren't affected.

### Local only, over stdio

If your MCP client runs on the same computer, it can launch AgentGo directly
instead:

```json
{
  "mcpServers": {
    "agentgo": {
      "command": "agentgo",
      "args": ["stdio"]
    }
  }
}
```

There's no tunnel or password in this mode. Runs only last as long as the
client keeps AgentGo open: when the client disconnects, runs in progress are
interrupted.

The stdio server and the background server can't use the same state directory
at the same time. Either stop the background server first, or give the stdio
one its own directory with `"args": ["stdio", "--state-dir", "/path"]` and add
workspaces to it with the same `--state-dir`.

## What the assistant can do

AgentGo gives the assistant 13 tools.

**Finding its way around.** These read files directly. They don't start an
agent.

| Tool | What it does |
| --- | --- |
| `listWorkspaces` | Lists the projects you've added |
| `listDirectory` | Lists the files and folders in a directory |
| `readFile` | Reads lines from a text file |
| `globFiles` | Finds files by name pattern, such as `src/**/*.ts` |
| `grepFiles` | Searches file contents with ripgrep |

**Running agents.**

| Tool | What it does |
| --- | --- |
| `getAgentCapabilities` | Shows which agents are installed and their versions |
| `getSupportedModels` | Lists the models, effort levels and service tiers each agent accepts |
| `startAgentRun` | Gives Codex or Claude Code a task in a workspace |
| `getAgentRunStatus` | Checks whether a run is queued, running or finished |
| `getAgentRunOutput` | Reads what the agent said and did, and its final answer |
| `listAgentRuns` | Lists past and current runs |
| `cancelAgentRun` | Stops a run |
| `continueAgentSession` | Sends a follow-up to a finished run, in the same conversation |

A run started by the assistant looks like this:

```json
{
  "provider": "codex",
  "model": "gpt-6.1-sol",
  "effort": "high",
  "serviceTier": "priority",
  "workspaceId": "my-app",
  "prompt": "Fix the failing tests and explain what was wrong.",
  "idempotencyKey": "fix-tests-1"
}
```

It returns straight away with a `taskId` and a `sessionId`. The assistant then
polls `getAgentRunStatus` and reads the result with `getAgentRunOutput`. To
follow up, it calls `continueAgentSession` with the `sessionId` and a new
prompt.

A few things worth knowing:

- **Agents approve their own actions.** Codex runs with its `workspace-write`
  sandbox and its automatic reviewer (`auto_review`). Claude Code runs in auto
  mode with permission prompts turned off. Their reviewers can still refuse
  an action. Nobody is there to answer questions mid-run, so if Codex asks
  for input, the run fails with `INPUT_REQUIRED`. There's no option to bypass
  permissions entirely.
- **The browsing tools are limited; the agents aren't.** `readFile`,
  `grepFiles` and the rest stay inside the workspace, don't follow symlinks,
  and refuse secrets such as `.env`, `.ssh`, `.aws`, `.git`, `.npmrc` and
  private keys. Agents are only held back by their own sandbox and reviewer,
  so they can read and run whatever those allow.
- **Models aren't guessed.** The assistant should call `getSupportedModels`
  first. Codex reports its own list. For Claude, AgentGo starts with the
  `sonnet` and `opus` aliases at low, medium and high effort; add others with
  `agentgo model add claude-sonnet-5-5 --efforts low,medium,high,xhigh,max`.
  An unknown model, effort or tier is an error, never silently swapped. Leave
  out `serviceTier` for Claude.
- **One run per workspace at a time.** Runs in the same workspace queue up so
  two agents never edit the same files at once. Different workspaces run side
  by side, two at a time by default.
- **Retries won't start a second run.** Each run carries an `idempotencyKey`.
  If the assistant retries with the same key and arguments, it gets the
  original run back. Reusing a key with different arguments is an error.
- **Runs have a time limit.** 30 minutes unless the assistant asks for longer
  with `limits.wallTimeSeconds`, up to an hour by default.
- **`succeeded` means the agent finished.** It doesn't mean the tests pass or
  the change is right.
- **The assistant sees what the agent shows.** Run output includes the
  agent's messages and the tools it used. For Codex it also includes the
  commands it ran, their output, and the files it changed. Hidden reasoning
  isn't included.
  If an agent prints a secret it read, that will be in the output too.

## Where AgentGo keeps its state

Everything lives in `~/.agentgo`: your workspaces and settings, the password,
tunnel settings, run history, the server log, and `cloudflared` if AgentGo
downloaded it. Use `--state-dir` or the `AGENTGO_HOME` environment variable to
put it somewhere else. Workspaces can't be inside it, or contain it.

Run history is kept for 30 days. After that, prompts and output are deleted,
but a small record of each run stays so a very late retry still can't start
it again. Codex and Claude Code keep their own conversation history
separately, and AgentGo doesn't touch it.

If the server stops unexpectedly, runs that were in progress are marked
`interrupted` when it next starts. They're never re-run automatically; check
the workspace for half-finished changes and continue the session yourself if
you want.

Agents don't inherit your whole environment. They get `PATH`, `HOME`, locale,
proxy settings, and the variables Codex and Claude Code use to log in
(`OPENAI_*`, `ANTHROPIC_*`, and the AWS, Google and Azure ones). The AgentGo
password is never passed to them.

`agentgo config show` prints the current settings. You can change these in
`~/.agentgo/config.json`:

| Setting | Default | What it controls |
| --- | --- | --- |
| `maxConcurrentRuns` | 2 | Runs that can go at once, across workspaces |
| `maxQueuedRuns` | 100 | Runs that can wait in the queue |
| `maxRunSeconds` | 3600 | The longest time limit a run can ask for |
| `maxRunOutputBytes` | 10 MiB | Output a run can produce before it's stopped |
| `retentionDays` | 30 | How long prompts and output are kept |
| `codexPath`, `claudePath`, `rgPath` | `codex`, `claude`, `rg` | Where to find each program |

## Using it as a library

```sh
npm install agentgo-mcp
```

`connectAgent` gives you a typed client for a running AgentGo server:

```ts
import { connectAgent } from 'agentgo-mcp';

const agent = await connectAgent({
  mcpConnectionURL: process.env.AGENTGO_URL!,
  token: process.env.AGENTGO_PASSWORD!,
});

try {
  const run = await agent.startAgentRun({
    provider: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    workspaceId: 'my-app',
    prompt: 'Fix the failing tests and explain what was wrong.',
    idempotencyKey: 'fix-tests-1',
  });

  let status = await agent.getAgentRunStatus(run.taskId);
  while (status.pollAfterMs) {
    await new Promise(resolve => setTimeout(resolve, status.pollAfterMs!));
    status = await agent.getAgentRunStatus(run.taskId);
  }

  const output = await agent.getAgentRunOutput(run.taskId);
  console.log(status.status, output.result?.text);
} finally {
  await agent.close();
}
```

The URL must be HTTPS, except on `localhost`. Every tool is also available as
`agent.call(name, args)`. To connect over stdio instead, pass
`{ transport: new StdioClientTransport({ command: 'agentgo', args: ['stdio'] }) }`,
importing `StdioClientTransport` from `@modelcontextprotocol/client/stdio`.

The package also exports the pieces the CLI is built from:

- `start`, `stop`, `status` and `restart` do what the commands do.
  `start({ downloadCloudflared: true })` returns the MCP URL and `token`.
- `serveAgentStdio({ stateDir })` serves over stdio from your own process.
- `AgentService.create({ stateDir })` loads the workspaces and run history.
  `createAgentMcpServer(service)` wraps it in an MCP server you can connect
  your own transport to, and `createAgentHttpServer({ service, token })` serves
  it over HTTP on `127.0.0.1` with password checks.

## Working on AgentGo

From a clone of this repo:

```sh
npm install
npm test
npm run typecheck
```

`npm test` builds first. The tests use fake `codex`, `claude` and
`cloudflared` programs, so they don't spend money or touch Cloudflare. They
need `rg` on your `PATH`.

There are also smoke tests against the real things:

```sh
npm run smoke:providers -- codex
npm run smoke:providers -- claude
npm run smoke:tunnel
```

`smoke:providers` runs two short real turns in a temporary folder, checking
that the agent can edit a file and remember the conversation. It uses your
normal Codex or Claude usage. `smoke:tunnel` starts a real Quick Tunnel and
checks that an authenticated client can reach AgentGo through it, without
running an agent. Add `-- --yes` to let it download `cloudflared`.

Before publishing, `npm pack --dry-run` shows what will go into the package.

## Codex and Claude Code terms

AgentGo isn't made by or affiliated with OpenAI or Anthropic. It runs the
`codex` and `claude` programs you installed, unmodified, and they use the
sign-in you already set up. AgentGo never handles or stores those logins.

Your OpenAI and Anthropic terms still apply to everything the agents do, so:

- **Keep it for yourself.** Giving someone else your AgentGo password lets
  them use your Codex and Claude accounts, which both companies' terms forbid.
- **Subscriptions are for ordinary, individual use.** If you're going to run
  agents heavily or unattended, sign the CLIs in with an API key instead.

## License

MIT. Parts of the Cloudflare hosting, storage and HTTP code are adapted from
[PrintGo](https://github.com/Nishkalkashyap/printgo); see `NOTICE`.
