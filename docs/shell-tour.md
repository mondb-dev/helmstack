# Shell tour

A short map of the desktop window, so you know where agent activity, approvals and overrides show up.

**Prerequisites:** the desktop app running. See [Getting started](getting-started.md).

## Top bar

| Element | What it does |
| --- | --- |
| Tab strip | One tab per page. Tabs an agent opened or is working in carry an agent badge. |
| **New tab** (`+`) | Opens a tab. |
| Theme toggle | Switches light and dark. The choice is remembered in the window's local storage. |
| Settings (gear) | Vault, accounts and approval policies. Visible only when the profile is `agent-substrate` or `full`. |
| Connection chip | Shows the agent API port and number of connected clients. Click for the connection popover. |

## Navigation bar

Back, forward, reload, the address bar, and **Select for agent**. Find in page (`Cmd/Ctrl+F`) and the zoom chip (shows the current zoom, click to reset to 100%) appear when used.

**Select for agent** (`Cmd/Ctrl+Shift+E`) lets you click an element in the page. Its selector, tag, id, trimmed text, page URL and tab id are saved as a pick that an agent reads with the `browser_get_selected_element` tool (HTTP: `GET /api/tabs/:id/picks/latest`, `GET /api/picks`). The daemon has no such button.

## Side panel

Toggle with `Cmd/Ctrl+Shift+A`. Up to four tabs:

- **Activity**: a live feed of what agents are doing, one row per API call or log line, with a filter. This is the place to check what an agent actually did. A command held for your approval shows as "Run page command - awaiting approval" with a clock, and the same row updates in place when it resolves: a check and "approved", a muted x and "rejected", or a muted "cancelled" (the page changed or the tab closed) or "expired". Rows never show the command, its arguments or page text.
- **Chat**: talk to an agent or a local model. See [Agent chat and local models](agent-chat.md).
- **Reports**: page analysis reports your agent has prepared, newest first. Each row shows the page, when it was written, who wrote it, findings counted by severity (critical, high, medium, low) and which measurements were included. **Open** shows the report in your default browser, **Save as…** copies it to a place you choose as HTML or Markdown, **Show in folder** reveals the file, and **Delete** asks for confirmation first. When an agent finishes a report a "Report ready" notification appears with **Open** and **Save as…**, and the tab shows a count until you view it. To get one, ask your agent: "analyze this page and prepare a report". The tab is hidden if the app build doesn't support reports. Findings are the agent's interpretation; HelmStack doesn't verify them.
- **Routines**: procedures an agent has proposed from something you asked for, such as "watch this page for updates on X and note anything new". Rows are grouped as **Needs review**, **Approved**, **Paused** and **Stopped / rejected** (collapsed). **Review…** opens the proposal in plain language with its risks, highest first, a **Show the technical spec** disclosure and, for a routine that changes things, **What it may do without asking**: every effect starts on "Ask me each time", and you can allow rearranging, adding or removing with daily and per-run limits and a never-remove list. If any risk is high, Approve stays disabled until you tick "I've read the risks". At the top: the engine state with **Stop all routines**, and **Model for judgment calls**, where you pick the model routines use. Each approved routine has **Run now**, **Cancel run**, **Pause**, **Resume**, **Stop** and **Delete**, a status chip (running, next run, last result), and **Details** with its runs and their logs, notes, memory (**Forget what it has seen**), actions waiting for you (**Approve** or **Decline**) and its **Reference library** (add a document, or review one an agent proposed). The tab counts routines to review, actions waiting and documents to review. Only you can approve, run, act on pending actions, change what a routine may do or use a document; agents can only propose and read. The tab is hidden if the app build doesn't support routines.

## Connection popover

Opened from the chip. It shows whether the API is listening, the number of event streams, agent ids seen, where the auth token comes from, and the profile. **Connect agents…** opens the install dialog ([Connect an agent](connect-an-agent.md)); **Copy MCP config** copies a ready JSON snippet.

If the port is taken, the popover shows "Not listening" and the error.

## Override chips

When an agent changes how a tab behaves (viewport, media emulation, resource budget, location, network mocks, recording, watches), a chip appears under the nav bar. Click a chip for details and **Clear**; **Clear all** resets the tab. This is how you notice that a page looks different because of an override, not a bug.

## Approvals

A banner appears when an agent's action needs your decision, with the site and a one-line summary. **Review** opens a dialog showing the page the request was made on and the effects (for example "share personal data"); choose approve or reject. **Later** leaves it pending. See [Approvals](approvals.md).

## Keyboard

`Cmd/Ctrl+/` opens the [shortcuts](keyboard-shortcuts.md) dialog.

## Verify it worked

Open a page, press `Cmd/Ctrl+Shift+A` to toggle the side panel, and click the connection chip to see the popover.
