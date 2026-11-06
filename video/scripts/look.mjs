// Dev helper: viewport screenshots of live routes at 1600x900 for planning the capture.
//   [OUT=<dir>] node scripts/look.mjs [route ...]   (default OUT: .cache/look)
import { launch, sleep } from "./cdp.mjs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { ROOT, setting } from "./dotenv.mjs";
// GET only: it opens each route, takes a screenshot and prints the visible text. It clicks nothing.
const BASE = setting("BASE", "http://localhost:3010");
const OUT = process.env.OUT || join(ROOT, ".cache/look");
mkdirSync(OUT, { recursive: true });
const routes = process.argv.slice(2).length ? process.argv.slice(2) : ["/", "/exchange", "/incorporate", "/desk", "/verify", "/rob"];
const b = await launch({ width: 1600, height: 900 });
for (const r of routes) {
  await b.goto(BASE + r, 9000);
  const name = r.replace(/[^a-z0-9]+/gi, "_") || "root";
  await b.shot(join(OUT, `${name}.png`));
  const h = await b.js("document.documentElement.scrollHeight");
  const text = await b.js("document.body.innerText.slice(0, 1500)");
  console.log("=====", r, "height", h, "\n", text);
}
console.log(b.consoleLines.slice(0, 10));
b.close();
