import { execFile } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// These positive fixtures are host-trusted UNIT controls, never namespace admission.
const binding = Object.freeze({ ownerId: "owner", companyId: "company", runId: "run", generation: "generation",
  launchId: "launch", agentId: "agent", issueId: "issue", processPid: 101, processStartedAt: "started" });
const outer = Object.freeze({ pid: 102, start: "123", bootId: "boot", uid: 1000, gid: 1000,
  userNamespace: { device: "4", inode: "20" }, pidNamespace: { device: "4", inode: "21" }, mountNamespace: { device: "4", inode: "22" } });
const binary = Object.freeze({ device: "2096", inode: "51826", size: "72160", sha256: "a".repeat(64) });
const observation = () => ({ version: 1 as const, nonce: "", bootId: "boot", kernelCredentialScope: "kernel-validated-referenced-process" as const,
  kernelCredentialClaims: { pid: 103, uid: 1000, gid: 1000 }, referencedProcess: { pid: 103, start: "124" },
  outer, namespaces: { user: { device: "4", inode: "30" }, pid: { device: "4", inode: "31" }, mount: { device: "4", inode: "32" } },
  root: { device: "2096", inode: "2", mountId: "9999" }, hostBinary: { ...binary, uid: 0, gid: 0, mode: 493, nlink: 1, regular: true as const, mountId: "10000" },
  peerBinary: { ...binary, uid: 0, gid: 0, mode: 493, nlink: 1, regular: true as const, mountId: "10001" },
  mountProof: { policy: "statmount-unique-v1" as const, hostFilesystem: "ext4" as const, peerFilesystem: "ext4" as const, hostIdmapped: false as const, peerIdmapped: false as const },
  ancestry: { user: true as const, pid: true as const } });
const live = (nonce = "unit-unbound") => ({ ...binding, state: "active" as const, heartbeatState: "running" as const, assignedAgentId: "agent", assignedIssueId: "issue", engineeringProfileApproved: true, outer,
  mountEvidencePolicy: "statmount-unique-v1" as const, consumerViewPolicy: "immutable-consumer-self-thread-namespace-root-file-comparison" as const,
  immutableConsumer: { bootstrapPortId: "unit-immutable-port", challengeId: "unit-challenge", nonce,
    selfThreadNamespaceRootFileComparisonRequired: true as const, liveConsumptionAndRevocationEnforced: true as const, singleConsumptionEnforced: true as const } });
const execute = promisify(execFile);
async function modules() {
  const core = await import("../services/workspace-binary-provenance.js").catch(() => null);
  const helper = await import("../../../packages/adapter-utils/src/workspace-binary-provenance-helper.js").catch(() => null);
  expect(core?.createWorkspaceBinaryProvenanceProducer, "standalone host producer required").toBeTypeOf("function");
  expect(helper?.WORKSPACE_BINARY_PROVENANCE_PYTHON, "fixed host collector required").toBeTypeOf("string");
  return { core: core!, helper: helper! };
}
async function python(script: string) {
  const { helper } = await modules();
  const result = await execute("/usr/bin/python3", ["-I", "-c", `scope = {"__name__": "unit_fixture"}\nexec(${JSON.stringify(helper.WORKSPACE_BINARY_PROVENANCE_PYTHON)}, scope)\n${script}`], { timeout: 5000, maxBuffer: 16384 });
  return JSON.parse(result.stdout);
}
async function fixture(overrides: Record<string, unknown> = {}) {
  const { core } = await modules();
  const keys = generateKeyPairSync("ed25519");
  let challenge = "";
  let stopped = false;
  let delivered: unknown;
  let value = observation();
  const session = {
    locator: "/unit-only.sock",
    observe: async () => ({ ...value, nonce: challenge }),
    recheck: async () => ({ ...value, nonce: challenge }),
    deliver: async (proof: unknown, beforeConsumption: () => Promise<void>) => { await beforeConsumption(); delivered = proof; },
    close: async () => { stopped = true; },
  };
  const suppliedAdmission = overrides.readLiveAdmission as undefined | ((...args: unknown[]) => Promise<ReturnType<typeof live> | null>);
  const producer = core.createWorkspaceBinaryProvenanceProducer({ binding, outer, expectedBinary: binary,
    issuer: { id: "operator-unit-only", privateKey: keys.privateKey },
    hostTransport: async (request: { nonce: string }) => { challenge = request.nonce; return session; },
    ...overrides,
    // Unit controls bind their explicit placeholder to the actual host nonce.
    // No production code creates or normalizes an immutable consumer admission.
    readLiveAdmission: async (identity, context) => {
      const value = suppliedAdmission ? await suppliedAdmission(identity, context) : live(context.nonce);
      return value?.immutableConsumer?.nonce === "unit-unbound"
        ? { ...value, immutableConsumer: { ...value.immutableConsumer, nonce: context.nonce } } : value;
    },
  });
  return { core, producer, keys, session, setObservation: (next: typeof value) => { value = next; },
    delivered: () => delivered, stopped: () => stopped };
}
async function sameHostOuterFixture() {
  const ns = async (kind: string) => {
    const value = await stat(`/proc/self/ns/${kind}`);
    return { device: String(value.dev), inode: String(value.ino) };
  };
  const value = await readFile("/proc/self/stat", "utf8");
  return { pid: process.pid, start: value.slice(value.lastIndexOf(")") + 2).split(" ")[19]!,
    bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), uid: process.getuid!(), gid: process.getgid!(),
    userNamespace: await ns("user"), pidNamespace: await ns("pid"), mountNamespace: await ns("mnt") };
}

describe("standalone provenance controller (unit admission only)", () => {
  it("signs bounded ownership facts with real Ed25519 and domain separation", async () => {
    const f = await fixture();
    const request = await f.producer.start();
    expect(request.nonce).toMatch(/^[0-9a-f]{64}$/);
    const proof = await f.producer.issue();
    expect(proof.issuerId).toBe("operator-unit-only");
    expect(proof.payload.binding).toEqual(binding);
    expect(proof.payload.observation.referencedProcess.pid).toBe(103);
    expect(proof.payload.observation.kernelCredentialScope).toBe("kernel-validated-referenced-process");
    expect(proof.payload.consumerContext).toEqual({ bootstrapPortId: "unit-immutable-port", challengeId: "unit-challenge" });
    expect(proof.payload.expiresAt - proof.payload.issuedAt).toBeLessThanOrEqual(1000);
    const wire = Buffer.from(proof.signedBytes, "base64");
    expect(wire.subarray(0, 41).toString()).toBe("paperclip.workspace-binary-provenance/v1\0");
    expect(JSON.parse(wire.subarray(41).toString())).toEqual(proof.payload);
    expect(verify(null, wire, f.keys.publicKey, Buffer.from(proof.signature, "base64"))).toBe(true);
    expect(f.delivered()).toEqual(proof);
    expect(f.stopped()).toBe(true);
    await expect(f.producer.issue()).rejects.toThrow("consumed");
  });

  it.each([
    ["no host admission", null], ["stopping owner", { ...live(), state: "stopping" }],
    ["wrong run", { ...live(), runId: "forged" }], ["wrong generation", { ...live(), generation: "forged" }],
    ["wrong company", { ...live(), companyId: "forged" }], ["wrong launch", { ...live(), launchId: "forged" }],
    ["heartbeat completed", { ...live(), heartbeatState: "succeeded" }], ["process replaced", { ...live(), processPid: 999 }],
    ["issue reassigned", { ...live(), assignedAgentId: "someone" }], ["wrong issue", { ...live(), assignedIssueId: "elsewhere" }],
    ["readonly profile", { ...live(), engineeringProfileApproved: false }],
    ["outer pins from another launch", { ...live(), outer: { ...outer, pid: 999 } }],
    ["no consumer view policy", { ...live(), consumerViewPolicy: undefined }],
    ["unadmitted future consumer", { ...live(), immutableConsumer: undefined }],
    ["wrong challenge nonce", { ...live(), immutableConsumer: { ...live().immutableConsumer, nonce: "b".repeat(64) } }],
    ["no self/thread/root/file comparison", { ...live(), immutableConsumer: { ...live().immutableConsumer, selfThreadNamespaceRootFileComparisonRequired: false } }],
    ["no live consumption/revocation", { ...live(), immutableConsumer: { ...live().immutableConsumer, liveConsumptionAndRevocationEnforced: false } }],
    ["no replay/consumption enforcement", { ...live(), immutableConsumer: { ...live().immutableConsumer, singleConsumptionEnforced: false } }],
    ["unadmitted mount policy", { ...live(), mountEvidencePolicy: "kernel-mountinfo-idmapped-v1" }],
  ])("refuses %s before starting transport", async (_name, admission) => {
    const f = await fixture({ readLiveAdmission: async () => admission });
    await expect(f.producer.start()).rejects.toThrow("admission");
    expect(f.delivered()).toBeUndefined();
  });

  it.each(["nonce", "boot", "outer", "ancestry", "threadScope", "peerUid", "uid", "symlink", "links", "writable", "hash", "inode", "overlay", "idmapped"])("refuses changed %s witness", async (kind) => {
    const f = await fixture();
    await f.producer.start();
    const bad = observation();
    if (kind === "nonce") f.session.observe = async () => ({ ...bad, nonce: "b".repeat(64) });
    if (kind === "boot") bad.bootId = "changed";
    if (kind === "outer") bad.outer = { ...outer, start: "changed" };
    if (kind === "ancestry") (bad.ancestry as { user: boolean }).user = false;
    if (kind === "threadScope") (bad as { kernelCredentialScope: string }).kernelCredentialScope = "sending-thread";
    if (kind === "peerUid") bad.kernelCredentialClaims.uid = 65534;
    if (kind === "uid") bad.hostBinary.uid = 1;
    if (kind === "symlink") (bad.peerBinary as { regular: boolean }).regular = false;
    if (kind === "links") bad.peerBinary.nlink = 2;
    if (kind === "writable") bad.peerBinary.mode = 511;
    if (kind === "hash") bad.peerBinary.sha256 = "b".repeat(64);
    if (kind === "inode") bad.peerBinary.inode = "changed";
    if (kind === "overlay") (bad.mountProof as { peerFilesystem: string }).peerFilesystem = "overlay";
    if (kind === "idmapped") (bad.mountProof as { peerIdmapped: boolean }).peerIdmapped = true;
    f.setObservation(bad);
    await expect(f.producer.issue()).rejects.toThrow("observation");
    expect(f.delivered()).toBeUndefined();
    expect(f.stopped()).toBe(true);
  });

  it("rejects a peer or namespace substitution between observation and pinned recheck", async () => {
    const f = await fixture();
    await f.producer.start();
    f.session.recheck = async () => ({ ...observation(), nonce: (await f.session.observe()).nonce,
      referencedProcess: { pid: 104, start: "124" }, kernelCredentialClaims: { pid: 104, uid: 1000, gid: 1000 } });
    await expect(f.producer.issue()).rejects.toThrow("changed");
    expect(f.delivered()).toBeUndefined();
  });

  it.each(["namespace", "root", "rootMount"])("rejects %s drift with the same process start", async kind => {
    const f = await fixture();
    await f.producer.start();
    f.session.recheck = async () => {
      const value = await f.session.observe();
      if (kind === "root") return { ...value, root: { ...value.root, inode: "99" } };
      if (kind === "rootMount") return { ...value, root: { ...value.root, mountId: "99" } };
      return { ...value, namespaces: { ...value.namespaces, mount: { device: "4", inode: "99" } } };
    };
    await expect(f.producer.issue()).rejects.toThrow("changed");
    expect(f.delivered()).toBeUndefined();
  });

  it("revokes in-flight admission without signing or delivery; close waits for cleanup", async () => {
    let resolve!: (value: ReturnType<typeof live>) => void;
    let reads = 0;
    const f = await fixture({ readLiveAdmission: async () => ++reads === 1 ? live() : new Promise(r => { resolve = r; }) });
    await f.producer.start();
    const issuing = f.producer.issue();
    await new Promise(r => setImmediate(r));
    await f.producer.close();
    resolve(live());
    await expect(issuing).rejects.toThrow("closed");
    expect(f.delivered()).toBeUndefined();
    expect(f.stopped()).toBe(true);
  });

  it("checks admission again after recheck and rejects revoked run", async () => {
    let reads = 0;
    const f = await fixture({ readLiveAdmission: async () => ++reads < 3 ? live() : null });
    await f.producer.start();
    await expect(f.producer.issue()).rejects.toThrow("admission");
    expect(f.delivered()).toBeUndefined();
    expect(f.stopped()).toBe(true);
  });

  it("checks live consumer/owner admission again before confirming ACK consumption", async () => {
    let reads = 0;
    const f = await fixture({ readLiveAdmission: async () => ++reads < 4 ? live() : null });
    await f.producer.start();
    await expect(f.producer.issue()).rejects.toThrow("admission");
    expect(f.delivered()).toBeUndefined();
    expect(f.stopped()).toBe(true);
    expect(reads).toBe(4);
  });

  it("rejects a bootstrap/challenge context substituted at consumption", async () => {
    let reads = 0;
    const f = await fixture({ readLiveAdmission: async () => ++reads < 4 ? live() : { ...live(), immutableConsumer: { ...live().immutableConsumer, challengeId: "substituted" } } });
    await f.producer.start();
    await expect(f.producer.issue()).rejects.toThrow("consumer_changed");
    expect(f.delivered()).toBeUndefined();
    expect(f.stopped()).toBe(true);
  });

  it("SCM capability-substitution semantics require independently admitted consumer self comparison (controlled CMSG fixture)", async () => {
    // Linux permits capability-authorized credential PID substitution. This
    // simulates the validated CMSG, WITHOUT creating namespaces or privileges.
    const decoded = await python(`import socket,struct,json\nclaims=(socket.SOL_SOCKET,socket.SCM_CREDENTIALS,struct.pack("3i",103,1000,1000))\nvalue=scope["decode_request"](json.dumps({"version":1,"nonce":"a"*64}).encode(),[claims],0,"a"*64)\nprint(json.dumps({"referencedPid":value[0]}))`);
    expect(decoded.referencedPid).toBe(103); // Does not prove actual requester 104.
    const independentlyBoundConsumerPid = 104;
    const f = await fixture({ readLiveAdmission: async (_binding: unknown, context: { nonce: string; observation?: ReturnType<typeof observation> }) => {
      if (context.observation && context.observation.referencedProcess.pid !== independentlyBoundConsumerPid) return null;
      return live(context.nonce);
    } });
    await f.producer.start(); // Only synthetic immutable consumer admission.
    await expect(f.producer.issue()).rejects.toThrow("admission");
    expect(f.delivered()).toBeUndefined();
    expect(f.stopped()).toBe(true);
  });

  it("close drains a helper whose startup completes after revocation", async () => {
    let finish!: () => void;
    let f!: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({ hostTransport: async () => new Promise(resolve => { finish = () => resolve(f.session); }) });
    const outcome = f.producer.start().then(() => "accepted", error => String(error));
    await new Promise(r => setImmediate(r));
    const closing = f.producer.close();
    finish();
    await closing;
    expect(await outcome).toMatch(/closed/);
    expect(f.stopped()).toBe(true);
    expect(f.delivered()).toBeUndefined();
  });

  it("permits exactly one issuance when requests race", async () => {
    const f = await fixture();
    await f.producer.start();
    const initial = await f.session.observe();
    let resolve!: (value: typeof initial) => void;
    f.session.observe = () => new Promise(r => { resolve = r; });
    const issuing = f.producer.issue();
    await expect(f.producer.issue()).rejects.toThrow("consumed");
    resolve(initial);
    expect((await issuing).payload.observation.referencedProcess.pid).toBe(103);
    expect(f.stopped()).toBe(true);
  });

  it("expires idle challenge and consumes it after failure", async () => {
    let now = 100;
    const f = await fixture({ clock: () => now, requestLifetimeMs: 100 });
    await f.producer.start();
    now = 201;
    await expect(f.producer.issue()).rejects.toThrow("expired");
    await expect(f.producer.issue()).rejects.toThrow("consumed");
    expect(f.stopped()).toBe(true);
  });

  it("rejects unapproved issuer material and does not trust a replaced signature key", async () => {
    await expect(fixture({ issuer: { id: "from-config", privateKey: "caller string" } })).rejects.toThrow("issuer");
    const f = await fixture();
    await f.producer.start();
    const proof = await f.producer.issue();
    const other = generateKeyPairSync("ed25519");
    expect(verify(null, Buffer.from(proof.signedBytes, "base64"), other.publicKey, Buffer.from(proof.signature, "base64"))).toBe(false);
  });

  it.each([
    ["uniform thread views do not establish SCM non-substitution", { ...live(), consumerViewPolicy: "host-verified-uniform-thread-view" }],
    ["a comparison flag lacks immutable bootstrap/challenge admission", { ...live(), immutableConsumer: undefined, immutableConsumerThreadComparisonAdmitted: true }],
  ])("refuses %s", async (_name, value) => {
    const f = await fixture({ readLiveAdmission: async () => value });
    await expect(f.producer.start()).rejects.toThrow("admission");
    expect(f.delivered()).toBeUndefined();
  });
});

describe("fixed Python collector boundaries (controlled private fixtures)", () => {
  it.each(["valid", "wrongPeer", "wrongNonce", "expired"])("retains real mount pins through signed expiry for %s ACK in a same-host unit fixture", async kind => {
    const { core, helper } = await modules();
    const directory = await mkdtemp("/tmp/hbp-");
    const locator = path.join(directory, "s");
    const actualOuter = await sameHostOuterFixture();
    const keys = generateKeyPairSync("ed25519");
    const actualBinary = { device: "2096", inode: "51826", size: "72160", sha256: "52231e1caf55bcbc667b269f49c63599a6f7db4767ae6a039580d0ff853db712" };
    // Synthetic owner/issuer/admission; real same-host sender/file/mount custody.
    // This is NOT a protected engineering/Group qualification.
    const producer = core.createWorkspaceBinaryProvenanceProducer({ binding, outer: actualOuter, expectedBinary: actualBinary,
      issuer: { id: "unit-only", privateKey: keys.privateKey }, socketPath: locator, proofLifetimeMs: 800,
      mountEvidencePolicy: "kernel-mountinfo-idmapped-v1", hostTransport: helper.startWorkspaceBinaryProvenanceHelper,
      readLiveAdmission: async (_binding, context) => ({ ...live(context.nonce), outer: actualOuter, mountEvidencePolicy: "kernel-mountinfo-idmapped-v1" }) });
    try {
      const request = await producer.start();
      let finished = false;
      const issuing = producer.issue().then(value => { finished = true; return { proof: value }; }, error => { finished = true; return { error: String(error) }; });
      const guest = await execute("/usr/bin/python3", ["-I", "-c", `import socket,json,os,struct,time\ns=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);s.connect(${JSON.stringify(locator)})\nhelper=struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[0]\ns.send(json.dumps({"version":1,"nonce":${JSON.stringify(request.nonce)}}).encode())\nproof=json.loads(s.recv(16384));kind=${JSON.stringify(kind)}\ndef pins():\n count=0\n for name in os.listdir("/proc/%d/fd"%helper):\n  try:\n   value=os.stat("/proc/%d/fd/%s"%(helper,name))\n   if value.st_dev==2096 and value.st_ino==51826: count+=1\n  except OSError: pass\n return count\nif kind=="expired":\n held=pins();time.sleep(0.85)\nack=json.dumps({"version":1,"nonce":"b"*64 if kind=="wrongNonce" else ${JSON.stringify(request.nonce)},"ack":True}).encode()\nif kind=="wrongPeer":\n child=os.fork()\n if child==0: s.send(ack);os._exit(0)\n os.waitpid(child,0)\nelse: s.send(ack)\nif kind!="expired": time.sleep(0.02);held=pins()\nraw=s.recv(1024);confirm=json.loads(raw) if raw else None\nprint(json.dumps({"pid":os.getpid(),"helperPid":helper,"heldBinaryPins":held,"confirm":confirm,"expiresAt":proof["payload"]["expiresAt"]}));s.close()`], { timeout: 4000 });
      const result = JSON.parse(guest.stdout);
      expect(result.heldBinaryPins).toBeGreaterThanOrEqual(2);
      if (kind === "valid") {
        expect(result.confirm.consumed).toBe(true);
        expect(finished).toBe(false); // ACK did not close/release the actual helper.
        const descriptors = await readdir(`/proc/${result.helperPid}/fd`);
        const held = await Promise.all(descriptors.map(async descriptor => {
          try { return await stat(`/proc/${result.helperPid}/fd/${descriptor}`); } catch { return null; }
        }));
        expect(held.filter(value => value?.dev === 2096 && value.ino === 51826).length).toBeGreaterThanOrEqual(2);
      } else expect(result.confirm).toBeNull();
      const outcome = await issuing;
      expect(Date.now()).toBeGreaterThanOrEqual(result.expiresAt);
      if (kind === "valid") {
        const proof = (outcome as { proof: Awaited<ReturnType<typeof producer.issue>> }).proof;
        expect(proof.payload.observation.referencedProcess.pid).toBe(result.pid);
        expect(verify(null, Buffer.from(proof.signedBytes, "base64"), keys.publicKey, Buffer.from(proof.signature, "base64"))).toBe(true);
      } else expect((outcome as { error: string }).error).toMatch(kind === "wrongPeer" ? /ack_peer_changed/ : kind === "expired" ? /host_proof_expired/ : /request_nonce_or_version/);
      await expect(access(`/proc/${result.helperPid}`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(locator)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await producer.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("drains a real idle helper and removes its self-owned socket on close", async () => {
    const { helper } = await modules();
    const directory = await mkdtemp("/tmp/hbp-"); // Unix pathname limit: the diagnostics root is too long.
    const locator = path.join(directory, "s");
    const abort = new AbortController();
    let session: Awaited<ReturnType<typeof helper.startWorkspaceBinaryProvenanceHelper>> | undefined;
    try {
      session = await helper.startWorkspaceBinaryProvenanceHelper({ nonce: "a".repeat(64), socketPath: locator, timeoutMs: 3000, outer, expectedBinary: binary }, abort.signal);
      await access(locator);
      const outcome = session.observe().then(() => "accepted", error => String(error));
      await session.close();
      expect(await outcome).toMatch(/closed|aborted/);
      await expect(access(locator)).rejects.toMatchObject({ code: "ENOENT" });
      await session.close();
    } finally { await session?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects a real socket request carrying a forged caller PID and cleans up", async () => {
    const { helper } = await modules();
    const directory = await mkdtemp("/tmp/hbp-");
    const locator = path.join(directory, "s");
    const abort = new AbortController();
    let session: Awaited<ReturnType<typeof helper.startWorkspaceBinaryProvenanceHelper>> | undefined;
    try {
      session = await helper.startWorkspaceBinaryProvenanceHelper({ nonce: "a".repeat(64), socketPath: locator, timeoutMs: 3000, outer, expectedBinary: binary }, abort.signal);
      const outcome = session.observe().then(() => "accepted", error => String(error));
      await execute("/usr/bin/python3", ["-I", "-c", `import socket,json\ns=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET); s.connect(${JSON.stringify(locator)}); s.send(json.dumps({"version":1,"nonce":"a"*64,"pid":1}).encode()); s.close()`], { timeout: 3000 });
      expect(await outcome).toMatch(/request_fields_unsupported/);
      await session.close();
      await expect(access(locator)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await session?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("aborts a real idle helper with no subprocess/socket left behind", async () => {
    const { helper } = await modules();
    const directory = await mkdtemp("/tmp/hbp-");
    const locator = path.join(directory, "s");
    const abort = new AbortController();
    let session: Awaited<ReturnType<typeof helper.startWorkspaceBinaryProvenanceHelper>> | undefined;
    try {
      session = await helper.startWorkspaceBinaryProvenanceHelper({ nonce: "a".repeat(64), socketPath: locator, timeoutMs: 3000, outer, expectedBinary: binary }, abort.signal);
      const outcome = session.observe().then(() => "accepted", error => String(error));
      abort.abort();
      await session.close();
      expect(await outcome).toMatch(/aborted/);
      await expect(access(locator)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await session?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("expires a real idle helper and removes the bound socket", async () => {
    const { helper } = await modules();
    const directory = await mkdtemp("/tmp/hbp-");
    const locator = path.join(directory, "s");
    let session: Awaited<ReturnType<typeof helper.startWorkspaceBinaryProvenanceHelper>> | undefined;
    try {
      session = await helper.startWorkspaceBinaryProvenanceHelper({ nonce: "a".repeat(64), socketPath: locator, timeoutMs: 300, outer, expectedBinary: binary }, new AbortController().signal);
      const outcome = session.observe().then(() => "accepted", error => String(error));
      expect(await outcome).toMatch(/expired/);
      await session.close();
      await expect(access(locator)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await session?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("automatic SCM credentials reference the sending child in an unprivileged inherited-socket sample", async () => {
    const result = await python(`import socket, os, json\na,b=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)\na.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1)\npid=os.fork()\nif pid==0:\n a.close(); b.send(json.dumps({"version":1,"nonce":"a"*64}).encode()); b.close(); os._exit(0)\nb.close()\ncredentials=scope["receive_request"](a,"a"*64)\nos.waitpid(pid,0)\na.close()\nprint(json.dumps({"sender":credentials[0],"expected":pid,"parent":os.getpid()}))`);
    expect(result.sender).toBe(result.expected);
    expect(result.sender).not.toBe(result.parent);
  });

  it.each(["notNamespace", "wrongKind", "closed", "observerMismatch"])("rejects %s host observer descriptor in a controlled fixture", async kind => {
    const result = await python(`import json,os\nkind=${JSON.stringify(kind)}\nfd=os.open("/proc/self/ns/user",os.O_RDONLY)\nif kind=="notNamespace": os.close(fd); fd=os.open("/dev/null",os.O_RDONLY)\nif kind=="wrongKind": os.close(fd); fd=os.open("/proc/self/ns/mnt",os.O_RDONLY)\nif kind=="closed": os.close(fd)\nif kind=="observerMismatch":\n original=scope["object_id"]\n scope["object_id"]=lambda value: {"device":"4","inode":"0"} if value==fd else original(value)\ntry:\n scope["require_host_observer"](fd); result="accepted"\nexcept Exception as e: result=str(e)\nfinally:\n if kind!="closed": os.close(fd)\nprint(json.dumps({"result":result}))`);
    expect(result.result).not.toBe("accepted");
  });

  it.each(["missing", "duplicate", "truncated", "oversize", "unsupported", "forgedPid", "replay"])("rejects %s request", async (kind) => {
    const result = await python(`import socket,struct,json\ncred=(socket.SOL_SOCKET,socket.SCM_CREDENTIALS,struct.pack("3i",123,1000,1000))\ndata=json.dumps({"version":1,"nonce":"a"*64}).encode(); anc=[cred]; flags=0\nkind=${JSON.stringify(kind)}\nif kind=="missing": anc=[]\nif kind=="duplicate": anc=[cred,cred]\nif kind=="truncated": flags=socket.MSG_CTRUNC\nif kind=="oversize": data=b"x"*1025\nif kind=="unsupported": anc=[cred,(socket.SOL_SOCKET,socket.SCM_RIGHTS,struct.pack("i",-1))]\nif kind=="forgedPid": data=json.dumps({"version":1,"nonce":"a"*64,"pid":123}).encode()\nif kind=="replay": data=json.dumps({"version":1,"nonce":"b"*64}).encode()\ntry:\n scope["decode_request"](data,anc,flags,"a"*64); result="accepted"\nexcept Exception as e: result=str(e)\nprint(json.dumps({"result":result}))`);
    expect(result.result).not.toBe("accepted");
  });

  it("pinned namespace ancestry rejects inaccessible parent without a PPID fallback", async () => {
    const result = await python(`import json,os\nfd=os.open("/proc/self/ns/user",os.O_RDONLY)\ntry:\n scope["namespace_descends"](fd,{"device":"4","inode":"999999"}); result="accepted"\nexcept Exception as e: result=str(e)\nfinally: os.close(fd)\nprint(json.dumps({"result":result}))`);
    expect(result.result).not.toBe("accepted");
  });

  it("rejects dead pidfd even if a reused process stat looks equal", async () => {
    const result = await python(`import json,os\nr,w=os.pipe(); os.close(w)\ntry:\n scope["require_alive"](r); result="accepted"\nexcept Exception as e: result=str(e)\nfinally: os.close(r)\nprint(json.dumps({"result":result}))`);
    expect(result.result).not.toBe("accepted");
  });

  it("rechecks a real exited process through its held pidfd", async () => {
    const result = await python(`import os,json\nr,w=os.pipe()\npid=os.fork()\nif pid==0:\n os.close(w); os.read(r,1); os._exit(0)\nos.close(r)\nfd=os.pidfd_open(pid)\nscope["require_alive"](fd)\nos.write(w,b"x"); os.close(w); os.waitpid(pid,0)\ntry:\n scope["require_alive"](fd); result="accepted"\nexcept Exception as e: result=str(e)\nfinally: os.close(fd)\nprint(json.dumps({"result":result}))`);
    expect(result.result).toBe("process_dead_or_reused");
  });

  it.each(["nonroot", "writable", "links", "symlink", "changed", "ctimeChanged"])("rejects %s binary using controlled stat fixture", async (kind) => {
    const result = await python(`import json,stat,types\nst=types.SimpleNamespace(st_mode=stat.S_IFREG|0o755,st_uid=0,st_gid=0,st_nlink=1,st_size=10,st_dev=2,st_ino=3,st_mtime_ns=4,st_ctime_ns=5)\nkind=${JSON.stringify(kind)}\nif kind=="nonroot": st.st_uid=65534\nif kind=="writable": st.st_mode=stat.S_IFREG|0o777\nif kind=="links": st.st_nlink=2\nif kind=="symlink": st.st_mode=stat.S_IFLNK|0o755\ntry:\n scope["validate_binary_stat"](st)\n if kind=="changed": scope["same_file_stat"](st,types.SimpleNamespace(**{**vars(st),"st_ino":9}))\n if kind=="ctimeChanged": scope["same_file_stat"](st,types.SimpleNamespace(**{**vars(st),"st_ctime_ns":9}))\n result="accepted"\nexcept Exception as e: result=str(e)\nprint(json.dumps({"result":result}))`);
    expect(result.result).not.toBe("accepted");
  });

  it("rejects unavailable mount proof without inferring safety from UID/hash", async () => {
    const result = await python(`import json,os\nfd=os.open("/usr/bin/bwrap",os.O_RDONLY)\ntry:\n witness=scope["mount_witness"](fd); result={"supported":True,"witness":witness}\nexcept Exception as e: result={"supported":False,"error":str(e)}\nfinally: os.close(fd)\nprint(json.dumps(result))`);
    // This machine's 6.6 kernel cannot provide STATX_MNT_ID_UNIQUE/statmount.
    if (!result.supported) expect(result.error).toMatch(/mount_.*unsupported|mount_.*unverified/);
    else expect(result.witness.idmapped).toBe(false);
  });

  it("collects genuine host ext4 mount evidence with a held actual binary FD", async () => {
    const result = await python(`import os,json\nfd=os.open("/usr/bin/bwrap",os.O_RDONLY)\nns=os.open("/proc/self/ns/mnt",os.O_RDONLY)\ntry:\n witness=scope["mountinfo_witness"](fd,os.getpid(),ns)\n first=scope["file_witness"](fd,"kernel-mountinfo-idmapped-v1",os.getpid(),ns)[0]\n second=scope["file_witness"](fd,"kernel-mountinfo-idmapped-v1",os.getpid(),ns)[0]\n print(json.dumps({"mount":witness,"binary":first,"stable":first==second}))\nfinally: os.close(fd); os.close(ns)`);
    expect(result.mount.filesystem).toBe("ext4");
    expect(result.mount.idmapped).toBe(false);
    expect(result.binary.uid).toBe(0);
    expect(result.binary.device).toBe("2096");
    expect(result.binary.inode).toBe("51826");
    expect(result.binary.sha256).toBe("52231e1caf55bcbc667b269f49c63599a6f7db4767ae6a039580d0ff853db712");
    expect(result.stable).toBe(true);
  });

  it.each(["idmapped", "overlay", "unknown", "unknownOptions", "unknownOptional", "ambiguous", "missing", "wrongDevice", "changedMountId", "pinClosed"])("rejects %s ordinary mount proof in controlled kernel-row fixture", async kind => {
    const result = await python(`import os,json\nfd=os.open("/usr/bin/bwrap",os.O_RDONLY); mid=scope["mount_id"](fd,False); st=os.fstat(fd)\nrow="%s 1 %s:%s / / rw - ext4 /dev/fixture rw\\n"%(mid,os.major(st.st_dev),os.minor(st.st_dev))\nkind=${JSON.stringify(kind)}\nif kind=="idmapped": row=row.replace("/ / rw -","/ / rw,idmapped -")\nif kind=="overlay": row=row.replace("- ext4 ","- overlay ")\nif kind=="unknown": row=row.replace("- ext4 ","- unknown ")\nif kind=="unknownOptions": row=row.replace("/ / rw -","/ / rw,unknown -")\nif kind=="unknownOptional": row=row.replace("/ / rw -","/ / rw unknown:1 -")\nif kind=="ambiguous": row+=row\nif kind=="missing": row="1 1 0:1 / / rw - ext4 /dev/fixture rw\\n"\nif kind=="wrongDevice": row=row.replace("%s:%s"%(os.major(st.st_dev),os.minor(st.st_dev)),"0:1")\nif kind=="changedMountId": mid+=1\nif kind=="pinClosed": os.close(fd)\ntry:\n scope["parse_mountinfo"](row,fd,mid); result="accepted"\nexcept Exception as e: result=str(e)\nfinally:\n if kind!="pinClosed": os.close(fd)\nprint(json.dumps({"result":result}))`);
    expect(result.result).not.toBe("accepted");
  });
});
