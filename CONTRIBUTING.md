# Contributing to HelmStack

Thank you for your interest in contributing to HelmStack! This guide will help you get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Branch Strategy](#branch-strategy)
- [Getting Started](#getting-started)
- [Commit Convention](#commit-convention)
- [Pull Request Process](#pull-request-process)
- [Development Workflow](#development-workflow)
- [Repository Structure](#repository-structure)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Branch Strategy

We use **Git Flow**:

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready releases. Merges here trigger automatic npm publishes. |
| `develop` | Integration branch. All feature PRs target this branch. |
| `feature/*` | New features — branch from `develop`. |
| `fix/*` | Bug fixes — branch from `develop`. |
| `release/*` | Release prep — branch from `develop`, merge to both `main` and `develop`. |
| `hotfix/*` | Urgent fixes — branch from `main`, merge to both `main` and `develop`. |

**Normal workflow:**

```
develop  ← feature/my-feature  (your PR goes here)
main     ← develop             (release merges trigger publishing)
```

## Getting Started

### Prerequisites

- **Node.js** ≥ 20
- **npm** ≥ 10
- **Git** with commit hooks enabled

### Setup

```bash
# Fork and clone
git clone https://github.com/<your-username>/helmstack.git
cd helmstack

# Install dependencies (includes git hooks via husky)
npm install

# Switch to the develop branch
git checkout develop

# Create your feature branch
git checkout -b feature/my-feature
```

### Build

```bash
# Build the desktop app
npm run build

# Build all publishable packages
npm run build:packages
```

### Test

```bash
# Run perception tests
npm run test:perception

# Run all tests
npm test
```

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must follow this format:

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `style` | Formatting, missing semicolons, etc. (no code change) |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `build` | Build system or external dependencies |
| `ci` | CI configuration changes |
| `chore` | Other changes that don't modify src or test files |

### Scopes

Use the package name without the `@helmstack/` prefix:

- `perception`, `shared`, `agent-sdk`, `mcp-server`, `desktop`

### Examples

```
feat(agent-sdk): add tab screenshot method
fix(perception): handle nested shadow roots correctly
docs: update contributing guide
ci: add Node 22 to test matrix
```

### Breaking Changes

Add `BREAKING CHANGE:` in the commit footer or `!` after the type:

```
feat(shared)!: rename BrowserOutputCommand to BrowserAction

BREAKING CHANGE: BrowserOutputCommand has been renamed to BrowserAction.
Update all imports accordingly.
```

Commits are validated by `commitlint` via a Git hook — invalid messages will be rejected.

## Pull Request Process

1. **Branch from `develop`** — never from `main` directly.
2. **Keep PRs focused** — one feature or fix per PR.
3. **Write tests** for new features and bug fixes.
4. **Ensure CI passes** — the PR must pass lint, build, and test checks.
5. **Fill out the PR template** — describe what changed and why.
6. **Request review** — at least one maintainer approval is required.

### PR Title Convention

PR titles should also follow conventional commit format since they are used in the squash-merge commit message:

```
feat(perception): add accessibility tree extraction
```

## Development Workflow

### Desktop App

```bash
# Start in dev mode (hot-reload)
npm run dev

# Serve test pages for manual testing
npm run serve:test-pages
```

### Perception Package

```bash
# Run tests in watch mode
npx vitest --watch

# Run a specific test file
npx vitest run packages/perception/test/dom-extractor.test.ts
```

### Agent SDK

The SDK is a zero-dependency TypeScript client. Test it against a running desktop instance:

```bash
# Start the desktop app
npm run dev

# In another terminal, run the example agent
cd apps/agent-example
npx tsx src/index.ts
```

## Repository Structure

```
helmstack/
├── apps/
│   ├── desktop/          # Electron shell (private, not published)
│   └── agent-example/    # Example agent (private, not published)
├── packages/
│   ├── agent-sdk/        # @helmstack/agent-sdk (published)
│   ├── mcp-server/       # @helmstack/mcp-server (published)
│   ├── perception/       # @helmstack/perception (published)
│   └── shared/           # @helmstack/shared (published)
├── docs/                 # Architecture and API documentation
└── sdk-example/          # Standalone SDK usage example
```

## Questions?

Open a [Discussion](https://github.com/mondb-dev/helmstack/discussions) or file an issue. We're happy to help!
