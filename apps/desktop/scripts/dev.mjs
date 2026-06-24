import { context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, watch } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the Electron binary path without ESM-importing the electron package
// (Node.js 22.16 has a bug pre-parsing CJS modules with string module.exports)
function resolveElectron() {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/electron");
  const executablePath = readFileSync(path.join(pkgDir, "path.txt"), "utf-8").trim();
  return path.join(pkgDir, "dist", executablePath);
}
const electron = resolveElectron();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const outDir = path.join(appRoot, "dist");
const tsconfig = path.join(appRoot, "tsconfig.json");

let electronChild = null;
let isShuttingDown = false;
let restartScheduled = false;
let initialBuildsCompleted = 0;
let staticWatcher = null;
let contexts = [];

function copyRendererAssets() {
  mkdirSync(path.join(outDir, "renderer"), { recursive: true });
  cpSync(path.join(appRoot, "src/renderer/index.html"), path.join(outDir, "renderer/index.html"));
  cpSync(path.join(appRoot, "src/renderer/styles"), path.join(outDir, "renderer/styles"), { recursive: true });
}

function launchElectron() {
  if (isShuttingDown || electronChild) {
    return;
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // VS Code sets this; must be unset for Electron browser mode

  electronChild = spawn(electron, [appRoot], {
    cwd: appRoot,
    stdio: "inherit",
    env
  });

  electronChild.once("exit", (code) => {
    electronChild = null;

    if (restartScheduled && !isShuttingDown) {
      restartScheduled = false;
      launchElectron();
      return;
    }

    if (!isShuttingDown) {
      shutdown(code ?? 0);
    }
  });
}

function scheduleRestart() {
  if (isShuttingDown) {
    return;
  }

  copyRendererAssets();

  if (initialBuildsCompleted < buildCount) {
    return;
  }

  if (!electronChild) {
    launchElectron();
    return;
  }

  restartScheduled = true;
  electronChild.kill();
}

async function shutdown(code = 0) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  if (staticWatcher) {
    staticWatcher.close();
  }

  if (electronChild) {
    electronChild.kill();
  }

  await Promise.all(contexts.map((entry) => entry.dispose()));
  process.exit(code);
}

copyRendererAssets();

const rebuildPlugin = {
  name: "electron-restart",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        return;
      }

      if (initialBuildsCompleted < buildCount) {
        initialBuildsCompleted += 1;
        if (initialBuildsCompleted === buildCount) {
          launchElectron();
        }
        return;
      }

      scheduleRestart();
    });
  }
};

const builds = [
  {
    entryPoints: [path.join(appRoot, "src/main/main.ts")],
    outfile: path.join(outDir, "main/main.cjs"),
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"]
  },
  {
    entryPoints: [path.join(appRoot, "src/preload/shell-preload.ts")],
    outfile: path.join(outDir, "preload/shell-preload.cjs"),
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"]
  },
  {
    entryPoints: [path.join(appRoot, "src/preload/page-preload.ts")],
    outfile: path.join(outDir, "preload/page-preload.cjs"),
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"]
  },
  {
    entryPoints: [path.join(appRoot, "src/renderer/shell.ts")],
    outfile: path.join(outDir, "renderer/shell.js"),
    platform: "browser",
    format: "esm",
    target: "chrome138"
  }
];

const buildCount = builds.length;

contexts = await Promise.all(
  builds.map((options) =>
    context({
      bundle: true,
      sourcemap: "inline",
      tsconfig,
      plugins: [rebuildPlugin],
      ...options
    })
  )
);

await Promise.all(contexts.map((entry) => entry.watch()));

staticWatcher = watch(path.join(appRoot, "src/renderer"), { recursive: true }, (_eventType, filename) => {
  if (!filename || (filename !== "index.html" && !filename.endsWith(".css"))) {
    return;
  }

  scheduleRestart();
});

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});
