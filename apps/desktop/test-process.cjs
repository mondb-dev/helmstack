console.log("process.type:", process.type);
console.log("process.versions.electron:", process.versions.electron);
const e = require("electron");
console.log("type:", typeof e, "app:", e.app);
// Maybe process.electronBinding is the way?
const eb = process.electronBinding || process._linkedBinding;
console.log("electronBinding:", typeof eb);
process.exit(0);
