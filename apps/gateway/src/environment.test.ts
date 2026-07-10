import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveProjectEnvFile } from "./environment.js";

test("explicit environment file wins over workspace discovery", () => {
  const result = resolveProjectEnvFile(
    {
      OPEN_GPT_LIVE_ENV_FILE: "/explicit/project.env",
      INIT_CWD: "/workspace"
    },
    "/workspace/apps/gateway",
    () => true
  );
  assert.equal(result, "/explicit/project.env");
});

test("pnpm INIT_CWD resolves the repository root .env", () => {
  const existing = new Set(["/workspace/.env"]);
  const result = resolveProjectEnvFile(
    { INIT_CWD: "/workspace" },
    "/workspace/apps/gateway",
    (path) => existing.has(path)
  );
  assert.equal(result, "/workspace/.env");
});

test("direct workspace execution falls back to two levels above", () => {
  const existing = new Set(["/workspace/.env"]);
  const result = resolveProjectEnvFile(
    {},
    "/workspace/apps/gateway",
    (path) => existing.has(path)
  );
  assert.equal(result, "/workspace/.env");
});
