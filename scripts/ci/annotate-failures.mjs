// Turns the failing lines of a test log into one GitHub Actions error annotation, so a failure
// is readable from the run's annotations without downloading the full log.
import { readFileSync } from "node:fs";

const file = process.argv[2];
const text = file ? readFileSync(file, "utf8") : "";
const interesting = /FAIL|Error|expected|received|×|✗|Unhandled|AssertionError|Timeout|EBUSY|EPERM|ENOENT|EACCES/;
const lines = text
  .split(/\r?\n/)
  .filter((line) => interesting.test(line))
  .map((line) => line.trim().slice(0, 300))
  .slice(0, 40);
const body = lines.length > 0 ? lines.join("\n") : `No failure lines found. Last output:\n${text.split(/\r?\n/).slice(-15).join("\n")}`;
const encoded = body.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
console.log(`::error title=Test failures::${encoded}`);
