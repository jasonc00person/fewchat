// Runs before every `npm run deploy`: refuses while setup placeholders are left, so a half-filled brand, script or
// config never goes live. Fill them in (SETUP.md step 2-5), then deploy again.
import { readFileSync } from "node:fs";

const FILES = ["src/brand.ts", "src/prompt.ts", "src/knowledge.ts", "wrangler.jsonc"];
const left = [];
for (const f of FILES) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (/<<FILL|REPLACE[_-]/.test(line)) left.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
}
if (left.length) {
  console.error(`Setup isn't finished: ${left.length} placeholder line(s) left.\n${left.join("\n")}`);
  process.exit(1);
}
