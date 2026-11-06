// Registers a screen recording made by hand (wallet-signed flows: pay, list, buy, pledge) as a clip.
//   node scripts/addclip.mjs <name> <file.mp4> [url shown in the browser bar]
// Re-encodes to 30 fps H.264 into public/footage/<name>.mp4 and adds it to src/footage.json, so any
// scene that names <name> plays it instead of its title card. The recording must be of the real app.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { ROOT } from "./dotenv.mjs";

const [name, file, url] = process.argv.slice(2);
if (!name || !file || !/^[a-z0-9_]+$/.test(name)) { console.error("usage: node scripts/addclip.mjs <name: a-z0-9_> <file.mp4> [url]"); process.exit(1); }
const src = resolve(file);
if (!existsSync(src)) { console.error(`no such file: ${src}`); process.exit(1); }
mkdirSync(join(ROOT, "public/footage"), { recursive: true });
const rel = `footage/${name}.mp4`;
const dst = join(ROOT, "public", rel);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-an", "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-crf", "15", "-preset", "medium", "-movflags", "+faststart", dst]);
const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", dst]).toString().trim().split(",").map(Number);
const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", dst]).toString());
const lib = join(ROOT, "src/footage.json");
const out = existsSync(lib) ? JSON.parse(readFileSync(lib, "utf8")) : {};
out[name] = { file: rel, width: w, height: h, durationFrames: Math.floor(dur * 30), marks: {}, url: url ?? "", owner: true };
writeFileSync(lib, JSON.stringify(out, null, 1));
console.log(`${name}: ${w}x${h} ${dur.toFixed(1)}s -> public/${rel}`);
