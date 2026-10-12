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
