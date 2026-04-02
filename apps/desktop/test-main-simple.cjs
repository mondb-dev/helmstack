console.log("process.type:", process.type);
const e = require("electron");
console.log("type:", typeof e, "app:", typeof e.app, "BW:", typeof e.BrowserWindow);
if (e.app) {
  e.app.whenReady().then(() => {
    console.log("Ready!");
    e.app.quit();
  });
}
