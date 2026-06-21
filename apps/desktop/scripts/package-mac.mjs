import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");
const require = createRequire(import.meta.url);

if (process.platform !== "darwin") {
  throw new Error("package:mac can only create a macOS .app bundle on macOS.");
}

await import("./build.mjs");

const desktopPackage = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"));
const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const electronPackagePath = require.resolve("electron/package.json");
const electronRoot = path.dirname(electronPackagePath);
const electronApp = path.join(electronRoot, "dist", "Electron.app");

const appName = "HelmStack";
const bundleId = "dev.mondb.helmstack";
const version = desktopPackage.version || rootPackage.version || "0.1.0";
const arch = process.arch;
const releaseDir = path.join(appRoot, "release");
const appOut = path.join(releaseDir, `${appName}.app`);
const zipOut = path.join(releaseDir, `${appName}-${version}-mac-${arch}.zip`);

if (!existsSync(electronApp)) {
  throw new Error(`Electron.app was not found at ${electronApp}`);
}

rmSync(appOut, { recursive: true, force: true });
rmSync(zipOut, { force: true });
mkdirSync(releaseDir, { recursive: true });

execFileSync("ditto", [electronApp, appOut]);

const contentsDir = path.join(appOut, "Contents");
const resourcesDir = path.join(contentsDir, "Resources");
const macOsDir = path.join(contentsDir, "MacOS");
const electronExecutable = path.join(macOsDir, "Electron");
const appExecutable = path.join(macOsDir, appName);

if (existsSync(electronExecutable)) {
  renameSync(electronExecutable, appExecutable);
}

const packagedAppDir = path.join(resourcesDir, "app");
rmSync(packagedAppDir, { recursive: true, force: true });
mkdirSync(packagedAppDir, { recursive: true });
cpSync(path.join(appRoot, "dist"), path.join(packagedAppDir, "dist"), { recursive: true });
cpSync(path.join(appRoot, "test-pages"), path.join(packagedAppDir, "test-pages"), { recursive: true });

writeFileSync(
  path.join(packagedAppDir, "package.json"),
  JSON.stringify(
    {
      name: "helmstack-desktop",
      productName: appName,
      version,
      description: desktopPackage.description || rootPackage.description,
      license: desktopPackage.license || rootPackage.license,
      main: "dist/main/main.cjs"
    },
    null,
    2
  )
);

const plistPath = path.join(contentsDir, "Info.plist");
setPlistValue(plistPath, "CFBundleDisplayName", appName);
setPlistValue(plistPath, "CFBundleName", appName);
setPlistValue(plistPath, "CFBundleExecutable", appName);
setPlistValue(plistPath, "CFBundleIdentifier", bundleId);
setPlistValue(plistPath, "CFBundleShortVersionString", version);
setPlistValue(plistPath, "CFBundleVersion", version);

removeBuildMetadata(appOut);
signApp(appOut);
execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appOut, zipOut], {
  cwd: releaseDir,
  stdio: "inherit"
});

console.log(`Packaged app: ${appOut}`);
console.log(`Release zip:  ${zipOut}`);

function setPlistValue(plistPath, key, value) {
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath]);
}

function signApp(appPath) {
  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "inherit" });
  } catch (error) {
    console.warn("Ad-hoc codesign failed; continuing with an unsigned local app bundle.");
    console.warn(error instanceof Error ? error.message : String(error));
  }
}

function removeBuildMetadata(root) {
  for (const child of readdirSync(root)) {
    const fullPath = path.join(root, child);
    if (child === ".DS_Store" || child === "__MACOSX") {
      rmSync(fullPath, { recursive: true, force: true });
      continue;
    }

    const stats = lstatSync(fullPath);
    if (stats.isDirectory()) {
      removeBuildMetadata(fullPath);
    }
  }
}
