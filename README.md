# pi-monitors

Monitors asynchronous events in Pi and posts notifications to the conversation.
The built-in `monitor_github_pr` tool registers an open GitHub pull request by its
canonical URL, such as `https://github.com/OWNER/REPO/pull/123`. It polls conversation
comments, submitted reviews, and inline review comments with read-only `gh`
requests, wakes the agent with bounded feedback, and reports a durable merged or
closed outcome before stopping.

## Requirements and install

- Pi and Node.js 24 or newer.
- GitHub CLI (`gh`) on `PATH`, authenticated with access to the PRs you monitor.
  Other adapters do not need `gh` unless they use it themselves.

Before installing, disable the original `extensions/pi-monitors` extension from
`pi-skills` with `pi config`. Do not load both copies.

```bash
pi install git:github.com/ryanmazzolini/pi-monitors
```

Run `/reload` or restart Pi after installation.

## Register and manage monitors

Ask the agent to call `monitor_github_pr` with the PR URL. The tool also instructs
the agent to register PRs it creates, updates, or reviews in this session, using
`notifyExistingFeedback: false` for updates and reviews. Existing feedback is
notified by default; `notifyExistingFeedback: false` records it without notifying
and still delivers later feedback and edits. Arbitrary `gh` commands do not
register monitors. Without registered monitors or restored registrations, the
GitHub adapter makes no requests and starts no polling timer.

`/monitors` opens the human-only panel in interactive TUI mode. Inspect active
monitors, refresh them, stop one, or dismiss a recent outcome. Active monitors
share one session status. The panel keeps at most ten recent outcomes; dismissing
one does not remove its durable notification from the conversation.

Monitor state and pending notifications persist in the session's active branch.
Reloading or resuming restores that branch's monitors; navigating the session tree
rebinds monitoring to the selected branch. A new session starts empty. Polling
runs while Pi is running, not as a separate background service, and registered
PRs do not depend on the current working directory.

GitHub feedback is untrusted external data. A notification does not authorize
edits, commits, pushes, merges, deployments, or follow-up work.

## Concourse deployment monitoring

The optional `monitor_concourse_deployment` tool watches one pipeline and an exact
40-character Git revision, such as `my-service-deploy` and the revision just
pushed. Loading the adapter does not start a watch.

Requirements:
- A `fly` CLI matching the Concourse server's version (tested with 7.10.0),
  logged in to the configured target and team.
- A persisted Pi conversation and a pipeline with a Git resource to track.

Log `fly` in once. The target name is what `pi-monitors.json` refers to; `fly`
stores the server URL and token for it in `~/.flyrc`:

```sh
/usr/local/bin/fly login -t ci -c https://ci.example.com -n main
```

A `fly` with a different major version from the server refuses most commands
with `out of sync with the target`. Compare `<flyPath> --version` with the
`version` returned by `https://ci.example.com/api/v1/info`. Running
`<flyPath> -t ci sync` replaces that binary with the server's version.

The adapter always runs the configured `flyPath`, never the `fly` on `PATH`. If
you have several installs, for example a newer one from Homebrew, set `flyPath`
to the one that matches your server.

Create `pi-monitors.json` in Pi's agent directory (normally `~/.pi/agent`, or
`PI_CODING_AGENT_DIR` when set):

```json
{
  "concourse": {
    "target": "ci",
    "team": "main",
    "resource": "repo",
    "flyPath": "/usr/local/bin/fly"
  }
}
```

Only `target` is required; the other values shown are defaults. Target, team, and
resource must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`: at most 63 characters,
with no leading hyphen. `flyPath` must be absolute, contain no control
characters, and be at most 512 UTF-8 bytes. Unknown keys inside `concourse` are rejected.

The config is read once when the extension loads. Run `/reload` or restart Pi
after changing it. Without the file or `concourse` key, Concourse is silently off.
Invalid config disables only Concourse and shows one warning at session start;
GitHub monitoring keeps working. The model supplies only `pipeline` and `revision`,
never the target, team, resource, or executable. The configured target selects the
Concourse instance and credentials from `~/.flyrc`.

Use `/monitors` to inspect, refresh, or stop the watch. It polls read-only every
30 seconds while Pi runs. Resuming or forking the conversation restores the watch;
leases under the agent directory's `pi-monitors/leases` prevent competing sessions
from watching the same deployment. A restored registration is discarded if its
target, team, or resource differs from the current config.

The adapter matches the exact revision and freezes the resource-connected job
graph. Every terminal job must succeed for success; a failed, errored, or aborted
matched build reports failure with the first failing build and its log tail.
Graph changes, connectivity failures, and expired authentication degrade monitor
health and retry with backoff capped at ten minutes, without waking the model.
Terminal outcomes use durable notifications, including batches shared with GitHub,
and the watch stops after acknowledgement.

Limits: one watch per session, 100 pipeline jobs, 500 builds for the exact resource
version, and ten matching resource versions. Job graphs are bounded to 16 KiB;
responses to 5 MiB; error output to 512 KiB; log tails to 200 lines and 16 KiB;
outcome content to 48 KiB. Logs are sanitized and redacted best-effort, not guaranteed
secret-free. External names, metadata, and logs remain untrusted data.

The adapter never triggers or retries builds, manages VPN connectivity, edits
pipelines, pushes code, rolls back, or deploys. Outcome messages grant no new
authority to act.

## Trusted adapters

Trusted extensions can contribute adapters without importing this package.
Listen through `pi.events.on("pi-monitors:discover-adapters:v1", handler)` during
extension setup. At session startup, the handler receives `{ version: 1,
register }`; call `register(adapter)` synchronously with a unique `id` and a
`bind(pi, services)` function. The returned session must implement the lifecycle
and monitor operations in [`types.ts`](./extensions/pi-monitors/types.ts).
Registration closes before adapter sessions start; late registration is rejected.

## Development and provenance

The nine runtime TypeScript files and seven test files were copied unchanged from
[`pi-skills` at `c2d1964103987417cb780c5fbcda43efacab70ae`](https://github.com/ryanmazzolini/pi-skills/tree/c2d1964103987417cb780c5fbcda43efacab70ae/extensions/pi-monitors).
The compiler settings are unchanged, including `strict: true`.

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm test
npm pack --dry-run --json
```

`npm test` runs strict TypeScript checking followed by Node's test runner.
The tarball includes the runtime extension, README, license, and package manifest,
not tests or development files. Pi supplies the host peer packages; there are no
runtime dependencies to install.

## License

MIT — see [LICENSE](./LICENSE).

AI assistance was used to extract and document this package.
