// Badge apps are authored as one file each, because that is what the badge
// installs and what the app guide asks for. The SPL1 link layer is shared by
// three of them and has its own test suite, so those apps carry a
// `--#include <path>` directive instead of a copy, and it is expanded here.
//
// Expansion happens on read rather than in a build step so that every consumer
// -- the website's installer endpoint, the CLI installer, and the test suite --
// necessarily sees the same thing, and no generated file can drift from source.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Only whole-line comments and blank lines are dropped, so a `--` inside a
// string literal is never touched. Slimming matters: the badge caps main.lua at
// 64 KiB and charges the module's bytecode against a 48/96 KiB Lua heap.
function slim(source) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("--");
    })
    .join("\n");
}

export function expandIncludes(source, baseDir, seen = new Set()) {
  return source.replace(/^[ \t]*--#include[ \t]+(\S+)[ \t]*$/gm, (_, rel) => {
    const path = resolve(baseDir, rel);
    if (seen.has(path)) throw new Error(`circular --#include of ${rel}`);
    seen.add(path);
    const name = rel.replace(/.*\//, "").replace(/\.lua$/, "");
    const body = expandIncludes(readFileSync(path, "utf8"), dirname(path), seen);
    return `local ${name} = (function()\n${slim(body)}\nend)()`;
  });
}

export function readBadgeApp(filename) {
  return expandIncludes(readFileSync(filename, "utf8"), dirname(filename));
}
