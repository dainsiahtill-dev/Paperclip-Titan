import { createRequire } from "node:module";

// jsdom's Undici 8 replaces Node's native proxy dispatcher during app startup.
// Initialize that same installed dependency with the instance's network proxy.
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  const serverRequire = createRequire(new URL("../server/package.json", import.meta.url));
  const jsdomRequire = createRequire(serverRequire.resolve("jsdom"));
  const { EnvHttpProxyAgent, setGlobalDispatcher } = jsdomRequire("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
