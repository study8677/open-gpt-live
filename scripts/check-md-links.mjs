#!/usr/bin/env node
/**
 * Validate local Markdown links/images only (no network).
 * Usage: node scripts/check-md-links.mjs [paths...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = process.argv.slice(2);
const files = targets.length
  ? targets.map((t) => path.resolve(root, t))
  : walkMarkdown(root);

const linkRe = /!?\[([^\]]*)\]\(([^)]+)\)/g;
let errors = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`missing file argument: ${file}`);
    errors++;
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  let m;
  while ((m = linkRe.exec(text))) {
    const href = m[2].trim().replace(/^<|>$/g, "");
    if (!href || href.startsWith("#")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // http(s), mailto, etc.
    const [filePart, hash] = href.split("#");
    if (!filePart) continue; // pure anchor already skipped
    const resolved = path.resolve(dir, filePart);
    if (!fs.existsSync(resolved)) {
      console.error(`${path.relative(root, file)}: broken local link -> ${href}`);
      errors++;
      continue;
    }
    if (hash) {
      const target = fs.readFileSync(resolved, "utf8");
      if (!hasHeadingAnchor(target, hash)) {
        console.error(
          `${path.relative(root, file)}: missing anchor #${hash} in ${filePart}`,
        );
        errors++;
      }
    }
  }
}

if (errors) {
  console.error(`\n${errors} local Markdown link issue(s).`);
  process.exit(1);
}
console.log(`OK: checked ${files.length} Markdown file(s) for local links.`);

function walkMarkdown(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "output") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMarkdown(p, acc);
    else if (ent.name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

function hasHeadingAnchor(md, anchor) {
  const want = anchor.toLowerCase();
  for (const line of md.split(/\r?\n/)) {
    const hm = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!hm) continue;
    const slug = hm[2]
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    if (slug === want) return true;
  }
  return false;
}
