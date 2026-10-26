/** Prepare a platform-neutral server + Web release; native dependencies install on the target. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "deploy");
const relative = path.relative(path.join(root, "dist"), output);
if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid deployment output");
for (const file of ["apps/server/dist/index.js", "packages/shared/dist/index.js", "apps/desktop/out/renderer/index.html"]) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Build first: missing ${file}`);
}
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

function copy(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (["node_modules", ".git", "__pycache__", "dist", "out"].includes(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Deployment resource cannot be a symlink: ${from}`);
    if (entry.isDirectory()) copy(from, to);
    else fs.copyFileSync(from, to);
  }
}
function copyBuilt(source, destination) {
  // Build output itself is required, so only filter nested resource directories in copy().
  copy(path.join(root, source), path.join(output, destination));
}
const serverPackage = JSON.parse(fs.readFileSync(path.join(root, "apps/server/package.json"), "utf8"));
const sharedPackage = JSON.parse(fs.readFileSync(path.join(root, "packages/shared/package.json"), "utf8"));
const desktopPackage = JSON.parse(fs.readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
copyBuilt("apps/server/dist", "server/dist");
copyBuilt("packages/shared/dist", "server/vendor/shared/dist");
copyBuilt("apps/desktop/out/renderer", "web");
for (const name of ["pi-packages", "skills-catalog", "agent-packs", "skin-packs"]) copyBuilt(name, name);
fs.writeFileSync(path.join(output, "server/package.json"), JSON.stringify({
  name: serverPackage.name, version: desktopPackage.version, private: true, type: "module",
  dependencies: { ...serverPackage.dependencies, "@office/shared": "file:vendor/shared" },
}, null, 2) + "\n");
fs.writeFileSync(path.join(output, "server/vendor/shared/package.json"), JSON.stringify({
  name: sharedPackage.name, version: sharedPackage.version, type: sharedPackage.type,
  main: sharedPackage.main, types: sharedPackage.types,
}, null, 2) + "\n");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
fs.writeFileSync(path.join(output, "release.json"), JSON.stringify({ version: desktopPackage.version, commit }, null, 2) + "\n");
const archive = `muniu-server-${desktopPackage.version}.tar.gz`;
execFileSync("tar", ["-czf", archive, "-C", "deploy", "."], { cwd: path.join(root, "dist"), stdio: "inherit" });
console.log(path.join(root, "dist", archive));
