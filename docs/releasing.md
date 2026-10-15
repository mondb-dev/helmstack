# Releasing

How versions and npm packages are produced.

**Prerequisites:** maintainer access to the repository and its secrets.

## How it works

Every push to `main` triggers `.github/workflows/release.yml`, which runs `multi-semantic-release` (semantic-release across the workspaces). It reads Conventional Commit messages since the last release, picks the next version per package, publishes to npm, creates GitHub releases and commits `CHANGELOG.md` and `package.json` back with the message `chore(release): <version> [skip ci]`. Configuration is `.releaserc.json` (branch `main`; plugins commit-analyzer, release-notes-generator, changelog, npm, github, git).

Version bumps follow the default commit-analyzer rules: `fix` and `perf` are patches, `feat` is a minor, a `BREAKING CHANGE:` footer or `!` is a major. Other types (`docs`, `ci`, `chore`, `test`, `refactor`) do not release by themselves.

## Skipping a release

Put `[skip release]` (or `[skip ci]`) in the head commit message of the push. The job's `if:` condition then skips the whole workflow. Use it for docs, CI and test-only pushes, as recent commits in this repository do.

## Preflight checks

Before publishing, the job runs four steps with `if: always()` so one run reports every missing prerequisite:

| Step | Checks | Fails when |
| --- | --- | --- |
| Preflight 1/4 | `NPM_TOKEN` secret is set | The secret is empty or missing |
| Preflight 2/4 | `npm whoami` with the token | The token is invalid |
| Preflight 3/4 | `npm access list packages @helmstack --json` | The token cannot see the `@helmstack` scope |
| Preflight 4/4 | `git push --dry-run` of `HEAD` to `main` with `GITHUB_TOKEN` | The workflow token cannot push to `main` |

## Current state

The `@helmstack/*` packages have never been published. The release is blocked on the `NPM_TOKEN` repository secret: it must be an npm token that can publish to the `@helmstack` scope. Until then the "Connect an agent" dialog reports "Package not published yet." for the `npx` source.

Packages that would be published (not marked `private`): `@helmstack/agent-sdk`, `@helmstack/mcp-server`, `@helmstack/perception`, `@helmstack/shared`, `@helmstack/daemon`. `@helmstack/devtools-core`, `@helmstack/desktop` and `@helmstack/agent-example` are private.

## Verify it worked

After a release run, `npm view @helmstack/mcp-server version` returns the new version and the GitHub Releases page lists it.
