import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

export function loadProjectEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): string | undefined {
  const path = resolveProjectEnvFile(env, cwd);
  if (path) {
    loadDotenv({ path, override: false });
  }
  return path;
}

export function resolveProjectEnvFile(
  env: NodeJS.ProcessEnv,
  cwd: string,
  fileExists: (path: string) => boolean = existsSync
): string | undefined {
  const candidates = [
    env.OPEN_GPT_LIVE_ENV_FILE,
    env.INIT_CWD ? resolve(env.INIT_CWD, ".env") : undefined,
    resolve(cwd, ".env"),
    resolve(cwd, "../../.env")
  ].filter((value): value is string => Boolean(value));

  for (const candidate of new Set(candidates)) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
