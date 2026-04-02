console.log("process.type:", process.type);

// Try direct process binding access
try {
  const mod = process.electronBinding?.("app");
  console.log("electronBinding(app):", mod);
} catch(e) { console.log("electronBinding error:", e.message); }

// Try the internal module system
try {
  const m = require("@electron/internal/main/startup");
  console.log("internal startup:", m);
} catch(e) { console.log("internal error:", e.message); }

process.exit(0);
