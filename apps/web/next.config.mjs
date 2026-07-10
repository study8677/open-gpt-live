import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

const envCandidates = [
  process.env.OPEN_GPT_LIVE_ENV_FILE,
  process.env.INIT_CWD ? resolve(process.env.INIT_CWD, ".env") : undefined,
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env")
].filter(Boolean);

for (const path of new Set(envCandidates)) {
  if (existsSync(path)) {
    loadDotenv({ path, override: false });
    break;
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@open-gpt-live/protocol"]
};

export default nextConfig;
