// @vitest-environment jsdom
import fs from "node:fs";
import { expect, it, vi } from "vitest";
it("shows entry-load recovery before React can mount an error boundary", async () => {
 const html=fs.readFileSync("ui/index.html","utf8");
 document.body.innerHTML=html.match(/<body>([\s\S]*?)<\/body>/)![1];
 expect(document.getElementById("root")?.textContent).toContain("正在加载");
 const classic=Array.from(document.querySelectorAll("script")).find(script=>!script.type)!;
 new Function(classic.textContent!)();
 const script=document.querySelector('script[type="module"]')!;
 const code=script.textContent!.replace(/import\([^)]*\)/,"load()");
 await new Function("load",code)(() => Promise.reject(new Error("offline")));
 await vi.waitFor(() => expect(document.getElementById("root")?.textContent).toContain("加载失败"));
 expect(document.querySelector('button')).not.toBeNull();
 document.body.innerHTML="";
});

it("recovers when the compiled module entry script cannot be fetched", async () => {
 const html=fs.readFileSync("ui/index.html","utf8");
 document.body.innerHTML=html.match(/<body>([\s\S]*?)<\/body>/)![1];
 const classic=Array.from(document.querySelectorAll("script")).find(script=>!script.type);
 if(classic) new Function(classic.textContent!)();
 const failed=document.createElement("script");failed.type="module";document.body.append(failed);
 failed.dispatchEvent(new Event("error"));
 await vi.waitFor(() => expect(document.getElementById("root")?.textContent).toContain("加载失败"));
 document.body.innerHTML="";
});

it("recovers from an early static dependency exception before the module body runs", async () => {
 const html=fs.readFileSync("ui/index.html","utf8");
 document.body.innerHTML=html.match(/<body>([\s\S]*?)<\/body>/)![1];
 const classic=Array.from(document.querySelectorAll("script")).find(script=>!script.type)!;
 new Function(classic.textContent!)();
 window.dispatchEvent(new ErrorEvent("error", { message: "Cannot convert undefined or null to object" }));
 await vi.waitFor(() => expect(document.getElementById("root")?.textContent).toContain("加载失败"));
 document.body.innerHTML="";
});

it("leaves failures after React mounts to the application boundaries", () => {
 const html=fs.readFileSync("ui/index.html","utf8");
 const scripts=html.match(/<body>([\s\S]*?)<\/body>/)![1];
 document.body.innerHTML=scripts;
 const classic=Array.from(document.querySelectorAll("script")).find(script=>!script.type)!;
 new Function(classic.textContent!)();
 document.getElementById("root")!.innerHTML="<main>Loaded application</main>";
 const failed=document.createElement("script");failed.type="module";document.body.append(failed);failed.dispatchEvent(new Event("error"));
 expect(document.querySelector("main")?.textContent).toBe("Loaded application");
 document.body.innerHTML="";
});
