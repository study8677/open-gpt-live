import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "check-md-links.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mdlinks-"));

fs.writeFileSync(path.join(tmp, "ok.md"), "[x](./target.md)\n![i](./img.png)\n");
fs.writeFileSync(path.join(tmp, "target.md"), "# Hello World\n");
fs.writeFileSync(path.join(tmp, "img.png"), "x");
fs.writeFileSync(path.join(tmp, "bad.md"), "[missing](./nope.md)\n");
fs.writeFileSync(path.join(tmp, "anchor.md"), "[a](./target.md#hello-world)\n");
fs.writeFileSync(path.join(tmp, "bad-anchor.md"), "[a](./target.md#missing)\n");

function run(file) {
  return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
}

let failed = 0;
function expect(name, cond) {
  if (!cond) {
    console.error("FAIL", name);
    failed++;
  } else console.log("OK", name);
}

expect("valid links", run(path.join(tmp, "ok.md")).status === 0);
expect("missing file", run(path.join(tmp, "bad.md")).status !== 0);
expect("good anchor", run(path.join(tmp, "anchor.md")).status === 0);
expect("bad anchor", run(path.join(tmp, "bad-anchor.md")).status !== 0);
expect("external ignored", (() => {
  const f = path.join(tmp, "ext.md");
  fs.writeFileSync(f, "[e](https://example.com/missing)\n");
  return run(f).status === 0;
})());

if (failed) process.exit(1);
console.log("all check-md-links fixtures passed");
