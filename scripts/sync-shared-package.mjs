import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDirectory, "..");
const source = path.join(root, "shared");
const destination = path.join(root, "node_modules", "@xbloom", "shared");

let existing = null;
try {
  existing = fs.lstatSync(destination);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

// Standard npm workspaces already expose shared through a directory link. The
// physical copy is only for exFAT/FAT volumes, where Windows reparse points are
// unavailable and the installer intentionally uses `npm ci --workspaces=false`.
if (existing?.isSymbolicLink()) {
  console.log("[build] @xbloom/shared workspace link is ready");
  process.exit(0);
}

if (process.argv.includes("--clean")) {
  if (existing) {
    fs.rmSync(destination, { recursive: true, force: true });
    console.log("[build] stale @xbloom/shared physical package removed");
  }
  process.exit(0);
}

if (existing) fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(path.join(source, "package.json"), path.join(destination, "package.json"));
fs.cpSync(path.join(source, "dist"), path.join(destination, "dist"), { recursive: true });
console.log("[build] @xbloom/shared physical package synchronized");
