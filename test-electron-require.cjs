const electron = require("electron");
console.log("typeof electron:", typeof electron);
console.log("electron.app:", electron.app);
console.log("electron.BrowserWindow:", electron.BrowserWindow);
console.log("keys:", Object.keys(electron).slice(0, 15));
