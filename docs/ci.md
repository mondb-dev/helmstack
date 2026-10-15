# CI

What the GitHub Actions workflows in `.github/workflows` run.

**Prerequisites:** none.

## `ci.yml`

Runs on pushes and pull requests to `main` and `develop`.

| Job | Runs on | What it does |
| --- | --- | --- |
| `lint-commits` (PRs only) | ubuntu | `commitlint` over the PR's commits |
| `build` ("Build & Test") | ubuntu, macOS, Windows × Node 20, 22 | `npm ci`, typecheck, lint, `build:packages`, desktop build (not on Linux, which has no display), docs check (Linux, Node 22), tests |
| `daemon-headless` | ubuntu, Node 22 | Installs Chrome for Testing with `@puppeteer/browsers`, relaxes the AppArmor user-namespace restriction, builds, and runs `vitest --project daemon --project contract` with `CI_REQUIRE_CHROME=1` |

Notes:

- The `build` job's test step also runs the real-Chrome tests where the runner image ships Chrome; they skip cleanly otherwise. The guaranteed-Chrome run is `daemon-headless`.
- Chrome for Testing has no setuid sandbox helper. On Ubuntu 23.10 and later it needs unprivileged user namespaces, so both Linux paths set `kernel.apparmor_restrict_unprivileged_userns=0` when that sysctl exists. Symptom without it: a hang with "Target.setDiscoverTargets timed out" or "No usable sandbox".
- `CHROME_VERSION` in the job's `env` picks the Chrome channel or a pinned build.

## `release.yml`

Runs on pushes to `main`. See [Releasing](releasing.md).

## Run the same checks locally

```bash
npm run typecheck && npm run lint && npm run docs:check && npm test
```

## Verify it worked

The checks appear on the pull request; all of `lint-commits`, every `build` matrix entry and `daemon-headless` must be green.
