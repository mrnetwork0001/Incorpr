// Before a render or still: copies the evidence files the film may quote and links the site's
// hero images, so both are served from public/ without being duplicated by hand.
//   docs/evidence/{mainnet,testnet}.json -> public/evidence/<network>.json (removed when the source is gone)
//   web/public/hero                       -> public/hero (a symlink; the images stay in web/)
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "./dotenv.mjs";

const SRC = resolve(ROOT, "../docs/evidence");
const DST = join(ROOT, "public/evidence");
mkdirSync(DST, { recursive: true });
for (const n of ["mainnet", "testnet"]) {
  const from = join(SRC, `${n}.json`);
  const to = join(DST, `${n}.json`);
  if (existsSync(from)) { copyFileSync(from, to); console.log(`evidence: ${n}.json copied`); }
  else if (existsSync(to)) { rmSync(to); console.log(`evidence: ${n}.json removed (no source)`); }
  else console.log(`evidence: no ${n}.json; scenes show no hashes`);
}

const hero = resolve(ROOT, "../web/public/hero");
const link = join(ROOT, "public/hero");
const linked = (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })();
if (existsSync(hero) && !linked && !existsSync(link)) { symlinkSync(hero, link, "dir"); console.log("hero: linked web/public/hero"); }
else console.log(existsSync(hero) ? "hero: linked" : "hero: web/public/hero missing; hands are left out");
