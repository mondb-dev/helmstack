# HelmStack — Autonomous Web-Agent Substrate Review & Backlog

A curated, evaluated checklist for hardening HelmStack as a **perception + execution layer for autonomous web agents** — the use case built around social-feed perception, OAuth/login automation, the encrypted account + TOTP vault, and the anti-detection layer.

Reviewed: 2026-06-18. Scope: `apps/desktop/src/main/*`, `packages/*`. Files of record: `site-capability-registry.ts`, `anti-detection.ts`, `account-store.ts`, `vault-store.ts`, `dom-actuator.ts`, `dom-extractor.ts`, `agent-server.ts`, `packages/agent-sdk`.

**Legend** — Priority: `P0` ship-blocker / `P1` high / `P2` nice-to-have. Effort: `S` <1d / `M` ~days / `L` >1wk.

---

## 0. The defining gap: there is no per-identity isolation

For an autonomous substrate that logs into accounts and runs *multiple* agents, the single most important property is that **each agent/identity is an isolated browser persona** — its own cookies, storage, and fingerprint. Today everything shares one Electron session partition (`persist:default`, `main.ts:40`) and one static fingerprint (`anti-detection.ts`). Consequences:

- All agents share one cookie jar and login state → two agents on the same site collide / hijack each other's sessions.
- Every account is operated from an *identical* fingerprint (same canvas seed per session, same GPU string, same UA, same timezone) → trivially linkable by any anti-fraud system. The anti-detection work is undermined by fingerprint *sameness*, which is a stronger signal than any single spoof.

- [ ] **`P0` `L` — Per-identity session profiles.** Introduce a "profile" abstraction that binds: a dedicated `session.fromPartition("persist:profile-<id>")`, a coherent fingerprint (canvas seed, GPU, UA + UA-CH, `hardwareConcurrency`, `deviceMemory`, screen metrics), a timezone/locale/`Accept-Language`, and optionally a proxy. Tabs/agents attach to a profile. This is the foundation everything else in this doc builds on.

---

## 1. Credential security & the approval model (highest-risk area)

- [ ] **`P0` `M` — Bind credential fills to the account's origin.** `AccountStore.resolveRef` (`account-store.ts:161`) returns the plaintext password/TOTP for *any* `accountId` an agent asks for, with **no check that the current tab's origin matches the account's bound `origins`**. A compromised or mistaken agent on `evil.com` can fill the GitHub password into a phishing form. The actuator then types it via CDP. Add an origin-guard at resolve/fill time: refuse (or require explicit approval) when `domainsMatch(account.origins, currentTabOrigin)` is false. This is the most serious substrate vulnerability.
- [ ] **`P0` `M` — Low-level actions bypass the approval system entirely.** `collectEffectsForCommand` (`site-capability-registry.ts:597`) only derives effects for `submit` and `dom.submit.*`. A raw `click` or `type` `BrowserAction`, or a `webmcp` tool invocation, produces **zero effects** → never triggers approval. An agent can submit a payment, accept terms, or post publicly using `click`/`type`/JS-submit and skip every policy. Either (a) classify effects from the *target element/context* (is this a checkout/pay/post/connect control) regardless of command type, or (b) require approval for any action on an element the perception layer tagged sensitive.
- [ ] **`P0` `S` — Two of four approval policies are dead code.** `submit_payment` (default `block`) and `accept_legal_terms` are defined in `approval-policy-store.ts` but **no code path ever emits those effect types** — only `share_personal_data` and `create_account` are produced. The "payments are blocked" guarantee is currently fiction. Wire real detection (checkout/payment forms, OAuth consent screens) to emit these effects.
- [ ] **`P1` `M` — Plaintext key fallback silently disables encryption.** Both `VaultStore` and `AccountStore` store the AES master key in `helmstack-vault.key` *next to* the encrypted data. When `safeStorage.isEncryptionAvailable()` is false (common on Linux without a keyring/libsecret), `keyProtection` falls back to `plaintext_fallback` — the key is written base64-plaintext beside the ciphertext, so the vault is effectively unencrypted. For a credential store this should be loud and opt-in: warn in UI + logs, and offer a user passphrase (PBKDF2/scrypt-derived key) so the vault is never trivially decryptable at rest.
- [ ] **`P1` `S` — Master key shared, never rotated, no integrity binding.** `AccountStore` and `VaultStore` share one key file by design; there's no rotation path and no AAD binding the ciphertext to a version/profile. Add key-rotation and pass the envelope `version` as GCM AAD.
- [ ] **`P2` `S` — TOTP is SHA1/6-digit/30s only.** `computeTotp` (`account-store.ts:258`) hardcodes the defaults. Support SHA256/SHA512, 7–8 digit, custom periods, and `otpauth://` URI import so it works with sites that deviate from the RFC defaults.
- [ ] **`P2` `S` — No audit trail of credential use.** `resolveRef` bumps `lastUsedAt` but logs nothing. For autonomous agents acting with stored creds, add an append-only audit log: which account field was injected into which origin/tab at what time, plus every approved/blocked effect.

---

## 2. Anti-detection — coverage is shallow and self-defeating

The current layer (`anti-detection.ts`) patches 9 surfaces. Modern fraud stacks (Cloudflare Turnstile, DataDome, PerimeterX, reCAPTCHA Enterprise) check dozens more, and several current choices actively *raise* suspicion.

- [ ] **`P0` `M` — `navigator.userAgentData` (Client Hints) is not spoofed at all.** UA-CH is now a primary signal and will directly contradict the spoofed `userAgent`/`platform`, flagging the session instantly. Patch `userAgentData.brands`, `mobile`, `platform`, and the high-entropy `getHighEntropyValues()` to match the chosen profile.
- [ ] **`P0` `M` — Direct CDP attachment is itself detectable.** Everything runs through `webContents.debugger.attach("1.3")` and `Runtime.evaluate`. The classic `Runtime.enable` / stack-trace and `console.debug` timing probes detect CDP-driven sessions regardless of fingerprint spoofing. Audit which CDP domains stay enabled, minimize `Runtime.enable` exposure, and consider in-page-world injection over CDP eval where possible.
- [ ] **`P1` `M` — Static, identical fingerprint per install.** GPU is hardcoded to "Apple M2" (`GPU_VENDOR`/`GPU_RENDERER`, lines 161–162) even on Windows/Linux hosts → contradicts `platform`. Canvas noise is a single LSB flip. Missing surfaces: AudioContext fingerprint, font enumeration, `navigator.connection`, `deviceMemory`, `hardwareConcurrency`, `screen`/`window` geometry, WebRTC local-IP leak, `Intl`/timezone coherence. Fold all of these into the per-profile fingerprint (§0) so each identity is internally consistent *and* distinct from the others.
- [ ] **`P1` `M` — Typing/clicking is trivially non-human.** The actuator sets `element.value = ...` and dispatches only `input`/`change` (`dom-actuator.ts:240`, `:423`) — no `keydown`/`keypress`/`keyup`, no per-character cadence, no focus dwell, no mouse movement/trajectory. `humanJitter` (60–220 ms) is the *only* behavioral cover. Behavioral biometrics detectors catch this immediately. Add a realistic input mode: dispatch real key events via CDP `Input.dispatchKeyEvent`/`Input.dispatchMouseEvent` with human-like timing curves (gated behind the stealth profile so dev/test can stay fast).
- [ ] **`P2` `S` — `chrome.runtime` is an empty object** (line 84). Real Chrome exposes `connect`, `sendMessage`, `id`, etc. Some detectors probe these. Flesh out or generate per-profile.
- [ ] **`P2` `M` — No proxy / egress-IP control.** Multi-account automation from a single residential/datacenter IP is a top correlation signal. Add per-profile proxy support (`session.setProxy`) so identity = fingerprint + IP + behavior, all coherent.
- [ ] **`P2` `S` — No way to verify the disguise.** Add a self-test against a known fingerprinting page (CreepJS-style) surfaced as a substrate report, so regressions in the spoof set are caught.

---

## 3. Execution layer — correctness & vocabulary

- [ ] **`P0` `M` — Form fills silently fail on React/Vue controlled inputs.** Setting `element.value` directly and firing `input` does **not** update React state — React tracks the native value setter and ignores the assignment, so the field reverts on re-render. Most social/SaaS targets are React. Fix: use the prototype's native value setter (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v)`) then dispatch `input`. Affects `typeFunctionSource` and `setFieldValue` in `dom-actuator.ts`. Without this, autonomous logins fail on a huge share of modern sites.
- [ ] **`P1` `M` — The command vocabulary is too small for real web flows.** Only `navigate/click/type/select/submit/await_human` + site tools. Missing primitives autonomous agents constantly need: `scroll` (feeds/infinite-load), `hover` (menus), `wait_for_selector`/`wait_for_idle`, `press_key`/keyboard shortcuts, `drag`, `dismiss_dialog`, `go_back/forward`. Add these as first-class `BrowserAction`s.
- [ ] **`P1` `S` — No pre-action wait.** `withDomRetry` (`site-capability-registry.ts:637`) only retries *after* a resolution failure. Add wait-for-present/visible/stable before acting to cut flakiness on SPA transitions.
- [ ] **`P2` `S` — Selector hints degrade to bare tag names.** `buildSelectorHint` (`dom-extractor.ts:944`) falls back to just the tag when no id/name/testid/role/aria-label exists; the actuator then leans on label matching (`dom-actuator.ts:369`). On dynamic feeds this collides. Add uniqueness-checked / nth-of-type / XPath fallbacks captured at observation time.
- [ ] **`P2` `S` — Backend node refs can go stale across re-render.** Actions resolve `backendNodeId` via CDP at execution time; SPA re-renders between perceive and act invalidate them. Re-resolve from the selector hint on `DOM.resolveNode` failure (partially handled by retry, but make it explicit).

---

## 4. Perception — social & login surfaces

- [ ] **`P1` `M` — No feed pagination / scroll-to-load.** `collectSocialPosts` caps at 10 visible posts (`dom-extractor.ts:330`) with no way to scroll and accumulate. Autonomous feed agents can't page through a timeline. Pair a `scroll` primitive (§3) with incremental, deduplicated post accumulation across observations.
- [ ] **`P1` `M` — Platform selectors are brittle and unversioned.** Social extraction hardcodes `[data-testid='tweet']`, `shreddit-post`, `feed-shared-update`, etc. (`dom-extractor.ts:313–343`). These break whenever a platform reships markup. Move them into a versioned, hot-updatable "selector pack" per platform so breakage is a data fix, not a code release.
- [ ] **`P1` `S` — Action state isn't captured.** `ObservedSocialAction` records label/kind/count but not *current state* — already liked? already following? Without "is this toggle on", agents double-toggle (unlike a post they meant to like). Capture `aria-pressed`/`aria-selected`/active-class state.
- [ ] **`P2` `M` — DM / message threads aren't extracted.** Surface kind `messages` is classified, but message content isn't pulled the way posts are. Add a messages extractor (thread participants, message list, composer).
- [ ] **`P2` `S` — OAuth detection is label-substring only.** `detectOAuthProvider` (`dom-extractor.ts:919`) matches provider names anywhere in a label → false positives (e.g. a post mentioning "apple"). Scope it to actual auth buttons / `href` to provider domains.
- [ ] **`P2` `S` — Login-success/failure isn't perceived.** There's no post-login verification signal (still on login page? error alert? redirected to app?). Add a derived "auth outcome" the agent can branch on instead of re-screenshotting.

---

## 5. Orchestration, resilience & observability

- [ ] **`P0` `S` — Agent isolation is forgeable.** Tab ownership keys off the self-asserted `X-Agent-ID` header (`agent-server.ts:211`); any client can claim any agent's id and reach its tabs/approvals/handoffs. Bind agent identity to the auth token (and to a session profile per §0), and document that the header alone is not a boundary.
- [ ] **`P0` `S` — Lock down the local API.** Wildcard CORS (`agent-server.ts:231`) + auth disabled by default (`isAuthorized` returns true when no token, line 828) means any web page the human visits can drive the substrate — including dumping the account list and reading cookies/storage. Require a token by default, validate `Origin`/`Host`, drop the `*` CORS.
- [ ] **`P1` `S` — SDK has no SSE reconnect.** `BrowserClient.stream()` opens the event stream once with no reconnect/backoff (no retry logic in `agent-sdk/src/index.ts`). A dropped stream silently stops `approval_queued` / `human_handoff_requested` / `page_observed` delivery, stalling agents. Add auto-reconnect with `Last-Event-ID` resume + heartbeat detection.
- [ ] **`P1` `S` — No runaway / rate-limit guard.** Beyond per-tab resource budgets, there's no global circuit breaker on action rate or approval-rejection streaks. An autonomous loop can hammer a site (and trip anti-fraud). Add per-profile action rate limiting and a kill-switch.
- [ ] **`P1` `M` — Inputs aren't validated at the REST boundary.** `readBody` returns `Record<string, unknown>` and the router casts straight to typed inputs (e.g. `body as AccountInput`, `body.rules as NetworkInterceptRule[]`). `zod` is already used in `mcp-server` — apply it here so malformed agent commands fail cleanly instead of corrupting state.
- [ ] **`P2` `S` — Approval/handoff stores are in-memory.** `ApprovalStore` and `HandoffStore` are `Map`s; an app restart drops pending approvals/handoffs and orphans any agent blocked in `waitForHandoffResolved`. Persist them (or at least emit a terminal "cancelled" event on shutdown so agents unblock).
- [ ] **`P2` `S` — Session capture/restore per account.** `captureStorage`/cookie APIs exist; expose a one-call "snapshot this logged-in session → restore into a fresh profile" so agents don't re-login (and re-trip 2FA) every run.

---

## 6. Testing & quality

- [ ] **`P0` `L` — The security-critical code is untested.** Only `packages/perception` has tests. `site-capability-registry.ts` (approval/effect logic, WebMCP), `account-store.ts` (origin matching, TOTP, crypto), `vault-store.ts`, `dom-actuator.ts`, `anti-detection.ts`, `agent-server.ts` — **zero tests**. Prioritize: effect-classification/approval-gating tests, origin-match tests (incl. the `domainsMatch` parent/child logic), TOTP vectors (RFC 6238 test vectors), and an HTTP-level agent-server suite.
- [ ] **`P1` `M` — Golden tests for injected scripts.** The anti-detection script, the DOM-traversal/actuation string, and the WebMCP probe/invoke strings are large `eval`'d blobs. Test them against fixtures (jsdom + a real fingerprint-probe page) so a tweak doesn't silently break stealth or actuation.
- [ ] **`P1` `S` — CI doesn't typecheck the desktop app or lint.** `ci.yml` skips the desktop build on Linux and runs no `tsc --noEmit` / ESLint gate. Add them so substrate regressions are caught pre-merge.
- [ ] **`P2` `M` — Live integration fixtures.** Add headless Electron e2e covering login (with a fake TOTP), approval gating, and handoff resolution against `apps/desktop/test-pages`.

---

## 7. Architecture & docs

- [ ] **`P1` `L` — Split `TabManager` (3,456 lines).** It owns tabs, perception, screenshots, perf, a11y, storage, network mock, recording, budgets, geolocation, accounts, vault, approvals, and handoffs. Extracting cohesive services (`ProfileManager`, `CredentialService`, `ActuationService`, `PerceptionService`) is a prerequisite for the per-profile isolation work in §0 and for testability in §6.
- [ ] **`P1` `S` — De-duplicate DOM traversal.** Shadow-root/iframe walking is implemented twice — typed in `dom-extractor.ts` (`collectQueryRoots`) and as a string in `dom-actuator.ts` (`collectRoots`). They will drift; perception will "see" nodes the actuator can't reach. Single source of truth, bundled into the page world.
- [ ] **`P2` `S` — Document the security & safety model.** A threat-model doc: what the vault protects (and the plaintext-fallback caveat), the origin-binding guarantee (once §1 lands), the approval matrix, that `X-Agent-ID` isn't auth, and the legal/ToS posture of anti-detection + social automation.
- [ ] **`P2` `S` — Fix `docs/dev-team-features.md` mis-headings** (the "Not Yet Implemented" section is full of ✅ items; the three.js block has garbled inline text) so the substrate docs stay trustworthy.

---

## Quick wins (start here)

1. Origin-bind credential fills — refuse cross-origin password injection (`§1`, `P0 M`).
2. Token auth on by default + drop wildcard CORS (`§5`, `P0 S`).
3. Fix React-controlled-input form fills via the native value setter (`§3`, `P0 M`).
4. Spoof `navigator.userAgentData` to match the UA (`§2`, `P0 M`).
5. Wake the dead `submit_payment` / `accept_legal_terms` policies, or document them as not-yet-enforced (`§1`, `P0 S`).

## Biggest bets (highest leverage)

1. Per-identity session profiles: partition + coherent fingerprint + timezone/locale + proxy (`§0`, `P0 L`).
2. Effect classification that can't be bypassed by low-level click/type (`§1`, `P0 M`).
3. Behavioral actuation (real key/mouse events, human timing) gated to the stealth profile (`§2`/`§3`, `P1 M`).
4. Versioned, hot-updatable social selector packs + feed pagination (`§4`, `P1 M`).
5. Test coverage for the credential/approval/crypto core (`§6`, `P0 L`).
