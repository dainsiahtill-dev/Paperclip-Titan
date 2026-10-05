import fs from "node:fs";
import path from "node:path";

/** Source checkouts serve their own build; published servers retain bundled assets. */
export function resolveStaticUiDist(serverDirectory: string, explicitDirectory?: string): string | undefined {
  if (explicitDirectory) {
    const selected = path.resolve(explicitDirectory);
    if (!fs.existsSync(path.join(selected, "index.html"))) {
      throw new Error(`UI build is missing at ${selected}; build @paperclipai/ui before starting static mode.`);
    }
    return selected;
  }
  const published = path.resolve(serverDirectory, "../ui-dist");
  const checkout = path.resolve(serverDirectory, "../../ui/dist");
  const candidates = path.basename(serverDirectory) === "src" ? [checkout, published] : [published, checkout];
  return candidates.find(candidate => fs.existsSync(path.join(candidate, "index.html")));
}
