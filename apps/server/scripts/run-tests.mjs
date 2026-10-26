import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "../src");
const files = fs
  .readdirSync(srcDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(srcDir, name));

for (const file of files) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", file], {
    cwd: path.resolve(here, ".."),
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
