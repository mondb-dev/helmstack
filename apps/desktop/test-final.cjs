const { app } = require('electron');
console.log("process.type:", process.type, "app:", app);
if (app) {
  app.whenReady().then(() => {
    console.log("ready!");
    app.quit();
  });
} else {
  console.log("app is undefined, electron module doesn't work!");
  process.exit(1);
}
