// Write expanded, single-file copies of the badge apps into badges/build/.
//
//   node tools/build-badge-apps.js [app.lua ...]
//
// The website and the CLI installer expand `--#include` on read via
// server/badge-source.js, so this is not part of any install path. It exists to
// check the 64 KiB main.lua limit and to give you a file you can paste into the
// official Badge IDE.
import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBadgeApp } from "../server/badge-source.js";

const here = dirname(fileURLToPath(import.meta.url));
const badges = resolve(here, "../badges");
const outDir = join(badges, "build");
const LIMIT = 64 * 1024;

export function buildApp(filename) {
  const built = readBadgeApp(filename);
  if (!built.includes("(function()")) return null;
  const slug = /^slug=(\S+)$/m.exec(built)?.[1];
  if (!slug) throw new Error(`${filename} has no slug= in its manifest header`);
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, `${slug}.lua`);
  writeFileSync(target, built);
  return { slug, target, bytes: Buffer.byteLength(built) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const files = args.length
    ? args.map((a) => resolve(a))
    : readdirSync(badges).filter((f) => f.endsWith(".lua")).map((f) => join(badges, f));
  let built = 0;
  for (const file of files) {
    const result = buildApp(file);
    if (!result) continue;
    built += 1;
    const over = result.bytes > LIMIT;
    console.log(`${result.slug.padEnd(24)} ${String(result.bytes).padStart(6)} bytes  ${over ? "OVER 64 KiB LIMIT" : "ok"}`);
    if (over) process.exitCode = 1;
  }
  if (built === 0) console.log("nothing to build (no --#include directives found)");
}
