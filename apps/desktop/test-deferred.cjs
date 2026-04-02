console.log("[sync] process.type:", process.type);
setTimeout(() => {
  console.log("[async] process.type:", process.type);
  const e = require("electron");
  console.log("[async] typeof e:", typeof e, "app:", typeof e.app);
  if (e.app) {
    e.app.quit();
  } else {
    process.exit(0);
  }
}, 100);
