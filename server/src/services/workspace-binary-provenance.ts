import { KeyObject, randomBytes, sign } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  startWorkspaceBinaryProvenanceHelper,
  type ProvenanceExpectedBinary,
  type ProvenanceOuterProcess,
  type ProvenanceMountEvidencePolicy,
  type WorkspaceBinaryHelperRequest,
  type WorkspaceBinaryHostObservation,
  type WorkspaceBinaryHostTransport,
} from "@paperclipai/adapter-utils/workspace-binary-provenance-helper";

export type WorkspaceBinaryOwnerBinding = Readonly<{
  ownerId: string; companyId: string; runId: string; generation: string; launchId: string;
  agentId: string; issueId: string; processPid: number; processStartedAt: string;
}>;
/** This comes from a HOST service closure that checks owner + heartbeat + issue.
 * It must never be filled from guest config/JSON/environment or cached admission.
 * Future integration must revoke synchronously on stopping/unknown/release.
 */
export type WorkspaceBinaryImmutableConsumerAdmission = Readonly<{
  bootstrapPortId: string; challengeId: string; nonce: string;
  selfThreadNamespaceRootFileComparisonRequired: true;
  liveConsumptionAndRevocationEnforced: true;
  singleConsumptionEnforced: true;
}>;
export type WorkspaceBinaryLiveAdmission = WorkspaceBinaryOwnerBinding & {
  state: "active"; heartbeatState: "running"; assignedAgentId: string; assignedIssueId: string;
  engineeringProfileApproved: boolean; outer: ProvenanceOuterProcess;
  mountEvidencePolicy: ProvenanceMountEvidencePolicy;
  consumerViewPolicy: "immutable-consumer-self-thread-namespace-root-file-comparison";
  /** HOST admission of an independently immutable consumer; NONE exists in current runtime. */
  immutableConsumer: WorkspaceBinaryImmutableConsumerAdmission;
};
/** An operator-admitted HOST capability. No default key generation/storage here.
 * An issuer name is metadata; consumer trust requires its independent issuer pin.
 */
export type WorkspaceBinaryHostIssuer = Readonly<{ id: string; privateKey: KeyObject }>;
export type WorkspaceBinaryProvenanceEnvelope = {
  version: 1; issuerId: string; algorithm: "Ed25519"; signedBytes: string; signature: string;
  payload: {
    version: 1; issuerId: string; purpose: "canonical-bwrap-ownership-facts"; canonicalPath: "/usr/bin/bwrap";
    binding: WorkspaceBinaryOwnerBinding; nonce: string; issuedAt: number; expiresAt: number;
    consumerViewPolicy: WorkspaceBinaryLiveAdmission["consumerViewPolicy"];
    consumerContext: { bootstrapPortId: string; challengeId: string };
    observation: WorkspaceBinaryHostObservation;
  };
};
export type WorkspaceBinaryProvenanceOptions = {
  binding: WorkspaceBinaryOwnerBinding; outer: ProvenanceOuterProcess; expectedBinary: ProvenanceExpectedBinary;
  issuer: WorkspaceBinaryHostIssuer;
  readLiveAdmission: (binding: WorkspaceBinaryOwnerBinding, context: Readonly<{
    nonce: string; observation?: WorkspaceBinaryHostObservation;
  }>) => Promise<WorkspaceBinaryLiveAdmission | null>;
  /** Required for the real transport. Private directory/guest visibility admission belongs to the host guard. */
  socketPath?: string;
  signal?: AbortSignal;
  requestLifetimeMs?: number;
  proofLifetimeMs?: number;
  mountEvidencePolicy?: ProvenanceMountEvidencePolicy;
  /** HOST-only injection. Controlled unit fixtures do not establish kernel admission. */
  hostTransport?: (request: WorkspaceBinaryHelperRequest, signal: AbortSignal) => Promise<WorkspaceBinaryHostTransport>;
  clock?: () => number;
};
export interface WorkspaceBinaryProvenanceProducer {
  start(): Promise<Readonly<{ version: 1; nonce: string; locator: string }>>;
  issue(): Promise<WorkspaceBinaryProvenanceEnvelope>;
  close(): Promise<void>;
}

const DOMAIN = Buffer.from("paperclip.workspace-binary-provenance/v1\0", "ascii");
const bindingKeys = ["ownerId", "companyId", "runId", "generation", "launchId", "agentId", "issueId", "processPid", "processStartedAt"] as const;
function requireFact(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`workspace_binary_provenance_${code}`);
}
function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.:/-]+$/.test(value);
}
function decimal(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,24}$/.test(value);
}
function namespace(value: unknown): boolean {
  const entry = value as { device?: unknown; inode?: unknown } | null;
  return !!entry && decimal(entry.device) && decimal(entry.inode);
}
function validateObservation(
  value: WorkspaceBinaryHostObservation, nonce: string, outer: ProvenanceOuterProcess, expected: ProvenanceExpectedBinary,
  policy: ProvenanceMountEvidencePolicy,
) {
  requireFact(value && value.version === 1 && value.nonce === nonce && value.bootId === outer.bootId && value.kernelCredentialScope === "kernel-validated-referenced-process" &&
    isDeepStrictEqual(value.outer, outer) && value.ancestry?.user === true && value.ancestry?.pid === true &&
    Number.isSafeInteger(value.referencedProcess?.pid) && value.referencedProcess.pid > 0 && decimal(value.referencedProcess.start) &&
    value.kernelCredentialClaims?.pid === value.referencedProcess.pid && value.kernelCredentialClaims.uid === outer.uid &&
    value.kernelCredentialClaims.gid === outer.gid && namespace(value.root) && decimal(value.root.mountId) &&
    namespace(value.namespaces?.user) && namespace(value.namespaces?.pid) && namespace(value.namespaces?.mount), "observation_invalid");
  for (const file of [value.hostBinary, value.peerBinary]) {
    requireFact(file && file.regular === true && file.uid === 0 && file.nlink === 1 &&
      Number.isInteger(file.gid) && file.gid >= 0 && Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o7777 &&
      !(file.mode & 0o7022) && !!(file.mode & 0o111) && decimal(file.mountId) &&
      file.device === expected.device && file.inode === expected.inode && file.size === expected.size && file.sha256 === expected.sha256,
    "observation_binary_invalid");
  }
  requireFact(value.mountProof?.policy === policy && value.mountProof.hostFilesystem === "ext4" && value.mountProof.peerFilesystem === "ext4" &&
    value.mountProof.hostIdmapped === false && value.mountProof.peerIdmapped === false, "observation_mount_unsupported");
  requireFact(Buffer.byteLength(JSON.stringify(value)) <= 8192, "observation_size");
}

/** One producer, one host-generated challenge, one referenced subject, one consumption.
 * Linux SCM credentials allow capability-authorized substitution. This module
 * never authenticates an actual sender from SCM claims, thread count or ACK.
 * Immutable consumer self/thread/view comparison and a live bootstrap challenge
 * are mandatory, independently admitted HOST capabilities. Current runtime has
 * no admitted consumer, so production admission must fail closed.
 * Facts are not JobTokens, project receipts, execution permission or settlement.
 * Host callbacks and private key stay in this closure; locator carries no trust.
 */
export function createWorkspaceBinaryProvenanceProducer(options: WorkspaceBinaryProvenanceOptions): WorkspaceBinaryProvenanceProducer {
  requireFact(options.issuer?.privateKey instanceof KeyObject && options.issuer.privateKey.type === "private" &&
    options.issuer.privateKey.asymmetricKeyType === "ed25519" && boundedString(options.issuer.id), "issuer_invalid");
  requireFact(typeof options.readLiveAdmission === "function", "admission_missing");
  const binding = Object.freeze(structuredClone(options.binding));
  requireFact(bindingKeys.every(key => key === "processPid" ? Number.isSafeInteger(binding[key]) && binding[key] > 0 : boundedString(binding[key])), "binding_invalid");
  const outer = structuredClone(options.outer);
  requireFact(Number.isSafeInteger(outer?.pid) && outer.pid > 0 && decimal(outer.start) && boundedString(outer.bootId) &&
    Number.isSafeInteger(outer.uid) && outer.uid >= 0 && Number.isSafeInteger(outer.gid) && outer.gid >= 0 &&
    namespace(outer.userNamespace) && namespace(outer.pidNamespace) && namespace(outer.mountNamespace), "outer_invalid");
  const expected = Object.freeze(structuredClone(options.expectedBinary));
  requireFact(decimal(expected?.device) && decimal(expected.inode) && decimal(expected.size) &&
    BigInt(expected.size) > 0n && BigInt(expected.size) <= 4n * 1024n * 1024n && /^[a-f0-9]{64}$/.test(expected.sha256), "expected_binary_invalid");
  const requestLifetime = options.requestLifetimeMs ?? 5000;
  const proofLifetime = options.proofLifetimeMs ?? 1000;
  requireFact(Number.isSafeInteger(requestLifetime) && requestLifetime > 0 && requestLifetime <= 5000 &&
    Number.isSafeInteger(proofLifetime) && proofLifetime > 0 && proofLifetime <= 1000, "lifetime_invalid");
  const clock = options.clock ?? Date.now;
  const issuerId = options.issuer.id;
  const privateKey = options.issuer.privateKey;
  const readAdmission = options.readLiveAdmission;
  const transportFactory = options.hostTransport ?? startWorkspaceBinaryProvenanceHelper;
  const socketPath = options.socketPath ?? "";
  const mountEvidencePolicy = options.mountEvidencePolicy ?? "statmount-unique-v1";
  requireFact(["statmount-unique-v1", "kernel-mountinfo-idmapped-v1"].includes(mountEvidencePolicy), "mount_policy_unadmitted");
  const abortController = new AbortController();
  const nonce = randomBytes(32).toString("hex");
  let phase: "new" | "starting" | "ready" | "issuing" | "consumed" = "new";
  let revoked = false;
  let session: WorkspaceBinaryHostTransport | undefined;
  let starting: Promise<WorkspaceBinaryHostTransport> | undefined;
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup: Promise<void> | undefined;
  let consumerContext: { bootstrapPortId: string; challengeId: string } | undefined;
  const assertOpen = () => requireFact(!revoked && !abortController.signal.aborted, "closed");
  const assertFresh = () => {
    assertOpen();
    const now = clock();
    requireFact(Number.isSafeInteger(now) && now >= 0 && now <= deadline, "request_expired");
  };
  const admission = async (observation?: WorkspaceBinaryHostObservation) => {
    assertOpen();
    const live = await readAdmission(binding, Object.freeze({ nonce, observation }));
    assertOpen();
    requireFact(live && bindingKeys.every(key => live[key] === binding[key]) && live.state === "active" &&
      live.heartbeatState === "running" && live.assignedAgentId === binding.agentId && live.assignedIssueId === binding.issueId &&
      live.engineeringProfileApproved === true && isDeepStrictEqual(live.outer, outer) && live.mountEvidencePolicy === mountEvidencePolicy &&
      live.consumerViewPolicy === "immutable-consumer-self-thread-namespace-root-file-comparison" &&
      live.immutableConsumer?.nonce === nonce && boundedString(live.immutableConsumer.bootstrapPortId) && boundedString(live.immutableConsumer.challengeId) &&
      live.immutableConsumer.selfThreadNamespaceRootFileComparisonRequired === true &&
      live.immutableConsumer.liveConsumptionAndRevocationEnforced === true && live.immutableConsumer.singleConsumptionEnforced === true, "admission_unverified");
    const currentContext = { bootstrapPortId: live.immutableConsumer.bootstrapPortId, challengeId: live.immutableConsumer.challengeId };
    requireFact(!consumerContext || isDeepStrictEqual(consumerContext, currentContext), "admission_consumer_changed");
    consumerContext ??= currentContext;
    return live;
  };
  const cleanupSession = async () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", externallyAborted);
    if (session) await session.close();
  };
  const close = (): Promise<void> => {
    revoked = true; // Set before awaiting; an in-flight callback can never issue later.
    abortController.abort();
    return cleanup ??= (async () => {
      if (starting) {
        try { session ??= await starting; } catch { /* Starter owns its failed-child cleanup. */ }
      }
      await cleanupSession();
    })();
  };
  function externallyAborted() { void close().catch(() => {}); }
  options.signal?.addEventListener("abort", externallyAborted, { once: true });
  if (options.signal?.aborted) externallyAborted();

  return {
    async start() {
      requireFact(phase === "new", "request_consumed");
      phase = "starting";
      try {
        await admission();
        const now = clock();
        requireFact(Number.isSafeInteger(now) && now >= 0, "clock_invalid");
        deadline = now + requestLifetime;
        timer = setTimeout(() => { void close().catch(() => {}); }, requestLifetime);
        starting = transportFactory({ nonce, socketPath, timeoutMs: requestLifetime, outer: structuredClone(outer), expectedBinary: expected, mountEvidencePolicy }, abortController.signal);
        session = await starting;
        assertFresh();
        requireFact(typeof session.locator === "string" && Buffer.byteLength(session.locator) <= 103, "locator_invalid");
        phase = "ready";
        return Object.freeze({ version: 1 as const, nonce, locator: session.locator });
      } catch (error) { phase = "consumed"; await close(); throw error; }
    },
    async issue() {
      requireFact(phase === "ready", "request_consumed");
      phase = "issuing";
      try {
        assertFresh();
        const observed = structuredClone(await session!.observe());
        assertFresh();
        validateObservation(observed, nonce, outer, expected, mountEvidencePolicy);
        await admission(observed);
        assertFresh();
        const current = structuredClone(await session!.recheck());
        assertFresh();
        validateObservation(current, nonce, outer, expected, mountEvidencePolicy);
        requireFact(isDeepStrictEqual(observed, current), "observation_changed");
        const finalAdmission = await admission(current);
        assertFresh();
        const issuedAt = clock();
        const payload: WorkspaceBinaryProvenanceEnvelope["payload"] = {
          version: 1, issuerId, purpose: "canonical-bwrap-ownership-facts", canonicalPath: "/usr/bin/bwrap",
          binding, nonce, issuedAt, expiresAt: Math.min(issuedAt + proofLifetime, deadline), observation: current,
          consumerViewPolicy: finalAdmission.consumerViewPolicy,
          consumerContext: { ...consumerContext! },
        };
        requireFact(payload.expiresAt > issuedAt, "request_expired");
        const bytes = Buffer.concat([DOMAIN, Buffer.from(JSON.stringify(payload), "utf8")]);
        requireFact(bytes.length <= 8192, "proof_size");
        // No await from the final revocation check through synchronous signing.
        assertFresh();
        const proof: WorkspaceBinaryProvenanceEnvelope = { version: 1, issuerId, algorithm: "Ed25519", payload,
          signedBytes: bytes.toString("base64"), signature: sign(null, bytes, privateKey).toString("base64") };
        requireFact(Buffer.byteLength(JSON.stringify(proof)) <= 16384, "proof_size");
        assertFresh();
        await session!.deliver(proof, async () => {
          assertFresh();
          await admission(current); // ACK is not authority; recheck HOST lifecycle/challenge.
          assertFresh();
        });
        assertFresh();
        return proof;
      } finally {
        phase = "consumed";
        await close();
      }
    },
    close,
  };
}
