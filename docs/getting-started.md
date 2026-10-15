# Getting started with the desktop app

You will run the HelmStack desktop app from a clone, open a local test page, and confirm that an agent can reach the API.

**Prerequisites:** Node 20 or newer, npm 10 or newer, a macOS, Windows or Linux machine with a display. There are no published installers yet; the app runs from source or from a local package build (`npm run package:mac` on macOS).

## Start the app

```bash
git clone https://github.com/mondb-dev/helmstack.git
cd helmstack
npm install
npm run dev
```

`npm run dev` builds the desktop app with esbuild and starts Electron. It restarts the app when sources change.

On start the app generates an agent API token, stores it in its user-data directory as `helmstack-agent-token`, and starts the API on `127.0.0.1:7070`. The desktop app logs only the token file path to its console on start, never the token itself.

To run a second instance next to an installed one, set `HELMSTACK_PORT` and `HELMSTACK_USER_DATA_DIR` before starting. See [Configuration](configuration.md).

## Open a test page

In a second terminal:

```bash
npm run serve:test-pages
```

It serves `apps/desktop/test-pages/` on `http://127.0.0.1:4177/` (change with `HELMSTACK_TEST_HOST` and `HELMSTACK_TEST_PORT`). Type `http://127.0.0.1:4177/contact-form.html` into the address bar of the app.

## Connect an agent

1. Click the connection chip at the top right (it shows the port, for example `:7070`).
2. Click **Connect agents…**.
3. Pick your client and follow [Connect an agent](connect-an-agent.md).

## Verify it worked

The status chip shows a green dot and the port. From a terminal, read the token from the path shown in the chip's popover and call the health route:

```bash
curl -H "X-HelmStack-Token: $(cat /path/shown/in/the/popover)" http://127.0.0.1:7070/api/health
```

You should see `"status":"ok"` and `"backend":"desktop"`. Once an agent calls a tool, the chip counts it ("1 client") and the **Activity** tab in the side panel lists the request.

## Next

- [Shell tour](shell-tour.md): what each part of the window does.
- [Keyboard shortcuts](keyboard-shortcuts.md).
- [Agent chat and local models](agent-chat.md): talk to an agent from inside the window.
- [Troubleshooting](troubleshooting.md).
