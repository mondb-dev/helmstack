// Hand-written meaning of every environment variable the code reads. The
// generator discovers the variable names (and where they are read) by scanning
// the source; a variable found in code with no entry here fails `docs:generate`,
// so a new variable cannot ship undocumented.
//
// `scope` says which program reads it. `default` is what applies when unset.

export const ENV = {
  HELMSTACK_PORT: {
    scope: "desktop, daemon, MCP server, SDK clients",
    default: "7070",
    text: "Port of the agent API. The desktop app and daemon listen on it (desktop ignores an invalid value with a console warning and uses 7070); the MCP server connects to it. The daemon's `--port` flag wins."
  },
  HELMSTACK_HOST: {
    scope: "MCP server, chat runner (passed to the MCP server it launches)",
    default: "127.0.0.1",
    text: "Host the MCP server connects to. The servers themselves always bind 127.0.0.1."
  },
  HELMSTACK_AUTH_TOKEN: {
    scope: "desktop, daemon, MCP server, SDK",
    default: "unset",
    text: "Agent API token. On the servers it replaces the generated token file; in the MCP server and SDK it is the token to send. Stripped from the environment of agent CLIs started by the chat."
  },
  HELMSTACK_TOKEN: {
    scope: "MCP server",
    default: "unset",
    text: "Alias the MCP server accepts when `HELMSTACK_AUTH_TOKEN` is not set."
  },
  HELMSTACK_TOKEN_FILE: {
    scope: "MCP server, SDK",
    default: "unset",
    text: "Path of a file holding the token. Read when no token variable is set. This is what \"Connect an agent\" writes into client configs, so the token itself is never copied."
  },
  HELMSTACK_AGENT_ID: {
    scope: "MCP server",
    default: "unset",
    text: "Sent as the `X-Agent-ID` header so activity and tab badges are attributed to a named agent. Advisory, not authentication."
  },
  HELMSTACK_TOOLSET: {
    scope: "MCP server",
    default: "full",
    text: "`full` registers the `browser_*` tools; `lite` registers the 14 compact verbs only. The `--toolset <lite|full>` argument wins."
  },
  HELMSTACK_PROFILE: {
    scope: "desktop, core, MCP server",
    default: "fe-dev",
    text: "`fe-dev`, `agent-substrate` or `full`. The last two turn on the opt-in agent surfaces (stealth, social perception, MCP approval/account tools). Unknown values mean `fe-dev`."
  },
  HELMSTACK_AGENT_SUBSTRATE: {
    scope: "MCP server",
    default: "unset (follows the profile)",
    text: "Explicit on/off (`1`, `true`, `on`, `yes`) for the MCP approval, handoff, account, TOTP and intent tools. Wins over the profile."
  },
  HELMSTACK_STEALTH: {
    scope: "desktop, core",
    default: "off (on with the agent-substrate and full profiles)",
    text: "Human-like input timing and the desktop's anti-detection injection. An explicit value wins over the profile."
  },
  HELMSTACK_SOCIAL: {
    scope: "desktop",
    default: "off (on with the agent-substrate and full profiles)",
    text: "Social-surface perception (feeds, posts, composers). Read by the desktop page preload; the daemon does not read it."
  },
  HELMSTACK_AGENT_APPROVALS: {
    scope: "desktop",
    default: "off",
    text: "`1` lets a token holder approve queued actions over the API (the desktop is otherwise human-only). The daemon always allows it."
  },
  HELMSTACK_APPROVAL_TTL_MS: {
    scope: "core (desktop and daemon)",
    default: "600000 (10 minutes)",
    text: "How long an unanswered approval waits before it is cancelled as expired. `0` disables expiry. A non-numeric value falls back to the default."
  },
  HELMSTACK_USER_DATA_DIR: {
    scope: "desktop",
    default: "Electron's userData directory",
    text: "Moves the desktop profile, vault, token file and stores, so a second instance does not share state."
  },
  HELMSTACK_CHROME_PATH: {
    scope: "daemon, real-Chrome tests",
    default: "auto-detect",
    text: "Chrome or Chromium executable for the daemon. If set but the file is missing, startup fails; it does not fall back to detection. The `--chrome-path` flag wins."
  },
  HELMSTACK_LOCAL_ENDPOINTS: {
    scope: "desktop chat (local models)",
    default: "Ollama :11434, LM Studio :1234, llama.cpp :8080",
    text: "Comma list of loopback URLs to probe. Port 11434 means Ollama; `ollama=URL` and `openai=URL` force a kind. Non-loopback entries are dropped; if nothing usable remains the defaults are used."
  },
  HELMSTACK_LOCAL_NUM_CTX: {
    scope: "desktop chat (local models)",
    default: "8192",
    text: "Ollama context window sent as `options.num_ctx`. Clamped to 2048 to 131072."
  },
  HELMSTACK_ROUTINE_MODEL: {
    scope: "routines (daemon fallback)",
    default: "unset",
    text: "`cli[:model]`, for example `claude`, `claude:haiku` or `ollama:llama3.2:3b`: the model that answers routine judgments, used only while no choice is saved from the Routines tab. The model is given no tools. Invalid values are ignored."
  },
  HELMSTACK_LITE_MAX_CHARS: {
    scope: "lite toolset (MCP server, local-model chat)",
    default: "2400",
    text: "Character cap of the page view the `look` verb returns. Clamped to 400 to 20000."
  },
  HELMSTACK_LITE_SCREENSHOT_DIR: {
    scope: "lite toolset",
    default: "<tmp>/helmstack-lite",
    text: "Directory the lite `screenshot` verb saves PNG files into."
  },
  HELMSTACK_TEST_HOST: {
    scope: "`npm run serve:test-pages`",
    default: "127.0.0.1",
    text: "Host of the bundled test-page server."
  },
  HELMSTACK_TEST_PORT: {
    scope: "`npm run serve:test-pages`",
    default: "4177",
    text: "Port of the bundled test-page server."
  },
  HELMSTACK_CONTRACT_URL: {
    scope: "contract test suite",
    default: "unset (suite skipped)",
    text: "Base URL of an already-running instance for the opt-in external contract run. Found in test sources only."
  },
  HELMSTACK_CONTRACT_TOKEN: {
    scope: "contract test suite",
    default: "unset",
    text: "Token for `HELMSTACK_CONTRACT_URL`."
  },
  CI_REQUIRE_CHROME: {
    scope: "real-Chrome tests",
    default: "unset",
    text: "`1` turns a missing Chrome into a test failure instead of a skip. Set by the `daemon-headless` CI job."
  },
  PUPPETEER_CACHE_DIR: {
    scope: "daemon Chrome discovery",
    default: "~/.cache/puppeteer",
    text: "Where Chrome for Testing installs from `@puppeteer/browsers` are looked up (`<dir>/chrome`)."
  },
  TASK: { scope: "apps/agent-example", default: "built-in sample task", text: "Task text for the example LLM agents." },
  OPENAI_API_KEY: { scope: "apps/agent-example (openai)", default: "required", text: "OpenAI key for the OpenAI example agent." },
  OPENAI_MODEL: { scope: "apps/agent-example (openai)", default: "gpt-4o", text: "Model for the OpenAI example agent." },
  MAX_STEPS: { scope: "apps/agent-example (openai)", default: "15", text: "Step limit for the OpenAI example agent." },
  VERTEX_PROJECT: { scope: "apps/agent-example (llm)", default: "unset", text: "Google Cloud project for the Vertex example agent." },
  VERTEX_LOCATION: { scope: "apps/agent-example (llm)", default: "us-central1", text: "Vertex region for the example agent." },
  VERTEX_MODEL: { scope: "apps/agent-example (llm)", default: "gemini-2.5-pro", text: "Vertex model for the example agent." },
  GOOGLE_APPLICATION_CREDENTIALS: { scope: "apps/agent-example (llm)", default: "unset", text: "Standard Google credentials file path read by the Vertex example agent." },
  ELECTRON_RUN_AS_NODE: {
    scope: "desktop (bundled MCP server launch)",
    default: "unset",
    text: "Set to `1` in client configs written by \"Connect an agent\" so the bundled MCP server runs on the app's own Node. `npm run dev` unsets it when it starts Electron."
  }
};

// Variables found in source that are not HelmStack settings (OS or third-party
// conventions the code merely consults). Listed so the scanner can ignore them.
export const IGNORED = new Set(["VITEST", "PATH", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "CODEX_HOME", "HOME", "GEMINI_CLI_SYSTEM_SETTINGS_PATH"]);
