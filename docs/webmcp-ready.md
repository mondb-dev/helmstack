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

## Immediate implementation path

1. Add a site capability registry in the main process.
2. Implement a `dom` provider over the existing perception layer.
3. Add a `webmcp` provider adapter that can report availability and tool manifests.
4. Route agent commands through `BrowserOutputCommand`.
5. Keep approvals in the browser substrate, not in the cognition runtime.
