import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const identityName = "paperclip-build.json";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function treeFiles(root, relative) {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? treeFiles(root, name) : entry.isFile() ? [name] : [];
  });
}
function fingerprint(root, files) {
  return hash(JSON.stringify(files.sort().map(file => [file, hash(fs.readFileSync(path.join(root, file)))])));
}
function sourceFiles(root) {
  const files = [...treeFiles(root, "ui/src"), ...treeFiles(root, "ui/public"), "ui/index.html", "ui/vite.config.ts", "ui/package.json", "scripts/ui-build-identity.mjs"];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "ui/package.json"), "utf8"));
  const dependencies = new Set(Object.entries(pkg.dependencies ?? {}).filter(([, version]) => version.startsWith("workspace:")).map(([name]) => name));
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const directory = path.posix.join(relative, entry.name);
      const packagePath = path.join(root, directory, "package.json");
      if (fs.existsSync(packagePath)) {
        const dependency = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        if (dependencies.has(dependency.name)) files.push(`${directory}/package.json`, ...treeFiles(root, `${directory}/src`), ...treeFiles(root, `${directory}/dist`));
      } else visit(directory);
    }
  }
  if (dependencies.size && fs.existsSync(path.join(root, "packages"))) visit("packages");
  for (const file of ["pnpm-lock.yaml", "tsconfig.base.json", "ui/tsconfig.json"]) {
    if (fs.existsSync(path.join(root, file))) files.push(file);
  }
  return files.filter(file => !file.endsWith("/.paperclip-build-complete") && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
}
function assetFiles(root) {
  return treeFiles(root, "ui/dist").filter(file => file !== `ui/dist/${identityName}`);
}
export function writeUiBuildIdentity(root) {
  const index = path.join(root, "ui/dist/index.html");
  if (!fs.existsSync(index)) throw new Error("UI build missing; run pnpm --filter @paperclipai/ui build.");
  const identity = { format: 1, sourceSha256: fingerprint(root, sourceFiles(root)), assetsSha256: fingerprint(root, assetFiles(root)) };
  fs.writeFileSync(path.join(root, "ui/dist", identityName), JSON.stringify(identity, null, 2) + "\n");
  return identity;
}
export function verifyUiBuildIdentity(root) {
  const identityPath = path.join(root, "ui/dist", identityName);
  if (!fs.existsSync(identityPath)) throw new Error("UI build identity missing; run pnpm --filter @paperclipai/ui build before static startup.");
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  if (identity.format !== 1 || identity.sourceSha256 !== fingerprint(root, sourceFiles(root))) throw new Error("UI source changed since build; run pnpm --filter @paperclipai/ui build before static startup.");
  if (identity.assetsSha256 !== fingerprint(root, assetFiles(root))) throw new Error("UI assets changed since build; run pnpm --filter @paperclipai/ui build before static startup.");
  return identity;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    if (!["write", "verify"].includes(process.argv[2])) throw new Error("Expected write or verify; identity is written only after a successful UI build.");
    console.log(JSON.stringify(process.argv[2] === "verify" ? verifyUiBuildIdentity(root) : writeUiBuildIdentity(root)));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
