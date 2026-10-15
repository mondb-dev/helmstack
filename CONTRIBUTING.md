# Contributing to HelmStack

Thanks for helping. This page gets you from a clone to a reviewed pull request.

## Prerequisites

- Node 20 or newer, npm 10 or newer, Git.
- A Chrome or Chromium if you work on the daemon (see [Headless and CI](docs/headless-ci.md#how-chrome-is-found)).

## Set up

```bash
git clone https://github.com/<you>/helmstack.git
cd helmstack
npm install        # also installs the commit-msg hook (husky + commitlint)
```

## Repository map

| Path | What it is | Published |
| --- | --- | --- |
| `packages/shared` | Types, CDP target contract, shortcut table | yes |
| `packages/perception` | In-page perception extractor | yes |
| `packages/devtools-core` | Core, agent server, stores, chat runner | no (bundled into the daemon) |
| `packages/agent-sdk` | HTTP client and lite toolset | yes |
| `packages/mcp-server` | `helmstack-mcp` | yes |
| `apps/desktop` | Electron app | no |
| `apps/daemon` | `helmstack-daemon` | yes |
| `apps/agent-example` | Example LLM agents | no |
| `scripts/docs` | Documentation generators and checks | no |

"Published" means the package is not marked `private`; nothing has been published yet. Architecture: [docs/architecture.md](docs/architecture.md).

## Everyday commands

| Task | Command |
| --- | --- |
| Run the desktop app with reload | `npm run dev` |
| Serve test pages on :4177 | `npm run serve:test-pages` |
| Build packages (and the daemon) | `npm run build:packages` |
| Build the desktop app | `npm run build` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| All tests | `npm test` |
| Regenerate generated docs | `npm run docs:generate` |
| Check docs | `npm run docs:check` |

More on tests: [docs/testing.md](docs/testing.md).

## Branches and pull requests

`main` is the only long-lived branch on the remote. Branch from it, keep pull requests focused, and open the PR against `main`. A push to `main` runs the release workflow, so use `[skip release]` in the head commit of changes that should not publish ([Releasing](docs/releasing.md)).

CI runs commit linting, typecheck, lint, build, tests on three operating systems, and a headless-Chrome job ([CI](docs/ci.md)). All must pass.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), checked by commitlint:

```text
<type>(<scope>): <subject>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`. Scopes are limited to: `desktop`, `agent-sdk`, `mcp-server`, `perception`, `shared`, `daemon`, `devtools-core`, `agent-example`, `deps`, `release` (a missing scope is allowed). Add `!` or a `BREAKING CHANGE:` footer for breaking changes.

```text
feat(devtools-core): add a route for X
fix(desktop): keep the approval banner after a reload
docs: update the troubleshooting guide
```

## Writing documentation

- Reference tables are generated; do not edit text between `<!-- generated:start name -->` and `<!-- generated:end -->`. Change the source (or `scripts/docs/env-descriptions.mjs` for environment variables) and run `npm run docs:generate`.
- A new environment variable that code reads must get an entry in `scripts/docs/env-descriptions.mjs`, or `docs:generate` fails.
- A new HTTP route should be added to the route comment block in `packages/devtools-core/src/http/agent-server.ts`; the generator lists routes found in code but missing from it.
- `npm run docs:check` also fails on broken relative links and anchors in `README.md`, `CONTRIBUTING.md` and `docs/`.
- Describe what exists. Put limits in a "Known limitations" section rather than promising features.

## Where things are tested

See [docs/testing.md](docs/testing.md). Real-Chrome tests skip when no Chrome is found; set `CI_REQUIRE_CHROME=1` to fail instead.

## Questions

Open a [discussion](https://github.com/mondb-dev/helmstack/discussions) or an issue. Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
