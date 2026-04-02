import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pagesRoot = path.resolve(__dirname, "../test-pages");
const host = process.env.HELMSTACK_TEST_HOST || "127.0.0.1";
const port = Number(process.env.HELMSTACK_TEST_PORT || "4177");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function resolvePath(urlPath) {
  const requestPath = urlPath === "/" ? "/contact-form.html" : urlPath;
  const absolutePath = path.resolve(pagesRoot, `.${requestPath}`);

  if (!absolutePath.startsWith(pagesRoot)) {
    return null;
  }

  return absolutePath;
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);

  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true, pagesRoot });
    return;
  }

  const absolutePath = resolvePath(url.pathname);
  if (!absolutePath || !existsSync(absolutePath) || statSync(absolutePath).isDirectory()) {
    sendJson(response, 404, { error: "Not found", path: url.pathname });
    return;
  }

  const extension = path.extname(absolutePath);
  response.writeHead(200, { "content-type": contentTypes.get(extension) || "application/octet-stream" });
  createReadStream(absolutePath).pipe(response);
});

server.listen(port, host, () => {
  process.stdout.write(`HelmStack test pages running at http://${host}:${port}/contact-form.html\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
