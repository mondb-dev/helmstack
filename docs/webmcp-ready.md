# WebMCP-Ready Browser Architecture

The browser owns perception and output. Cognition is external and pluggable.

## Core rule

- The browser is the substrate: tabs, DOM/AX/media perception, site capabilities, approvals, and execution.
- The agent is replaceable: OpenAI, Anthropic, LangGraph, MCP clients, or any custom runtime.
- Site integrations are providers: raw DOM perception today, WebMCP when available.

## Runtime split

1. `BrowserSubstrateApi`
   - emits `BrowserPerceptionPacket`
   - executes `BrowserOutputCommand`
   - lists site capability manifests
2. `CognitiveRuntimeAdapter`
   - consumes packets
   - returns commands and expected effects
3. `SiteCapabilityProvider`
   - `dom`: infer actions from DOM/AX/media
   - `webmcp`: invoke site-defined tools when exposed

## Why this matches WebMCP

- WebMCP is site-supplied structured capability, not the cognition layer.
- The browser should detect and expose WebMCP as a provider alongside DOM-based perception.
- Agents should not care whether a command was satisfied by DOM actuation or a site tool.

## Selection policy

Per tab:

1. Discover `webmcp` capabilities.
2. If available, prefer `invoke_site_tool`.
3. If unavailable or incomplete, fall back to DOM perception and browser actions.
4. Merge both into one `BrowserPerceptionPacket`.

## Implementation status

**Done:**

1. ✅ Site capability registry in the main process (`site-capability-registry.ts`)
2. ✅ `dom` provider over the existing perception layer
3. ✅ `webmcp` provider — detection, tool enumeration, and tool invocation (`navigator.webMcp.invoke`, `window.WebMCP.invoke`, `script[type="application/webmcp+json"]` fetch fallback)
4. ✅ Agent commands routed through `BrowserOutputCommand`
5. ✅ Approvals in the browser substrate (not in the cognition runtime)
6. ✅ HTTP+SSE agent server on `127.0.0.1:7070`
7. ✅ TypeScript agent SDK (`@helmstack/agent-sdk`)

**Now implemented:**

- WebMCP manifest schema validation with surfaced validation issues
- Provider preference logic that marks and orders the preferred provider per tab
