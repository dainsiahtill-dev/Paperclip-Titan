/** Inherited kernel policy protecting the outer PID-1 custodian while allowing
 * provider sandboxes to create descendant user/PID/mount namespaces. The
 * filter cannot be removed by gaining capabilities inside a child userns. */
export function workspaceCustodianSeccomp(arch: string = process.arch): Buffer {
  const abi = arch === "x64" ? {
    audit: 0xc000003e, setns: 308, ptrace: 101, writev: 311, pidfdSignal: 424, pidfdGetfd: 438,
    signals: [62, 200, 234, 129, 297],
  } : arch === "arm64" ? {
    audit: 0xc00000b7, setns: 268, ptrace: 117, writev: 271, pidfdSignal: 424, pidfdGetfd: 438,
    signals: [129, 130, 131, 138, 240],
  } : null;
  if (!abi) throw new Error("Protected workspace requires a supported seccomp ABI");
  type Instruction = { code: number; value: number; yes?: string; no?: string };
  const instructions: Instruction[] = [], labels = new Map<string, number>();
  const add = (code: number, value: number, yes?: string, no?: string) => instructions.push({ code, value, yes, no });
  const label = (name: string) => labels.set(name, instructions.length);
  const load = 0x20, equal = 0x15, bits = 0x45, ret = 0x06;
  add(load, 4); // seccomp_data.arch
  add(equal, abi.audit, "syscall", "wrong_abi");
  label("wrong_abi"); add(ret, 0x80000000); // KILL_PROCESS, including compat ABIs
  label("syscall"); add(load, 0);
  if (arch === "x64") {
    add(bits, 0x40000000, "wrong_abi_x32", "native");
    label("wrong_abi_x32"); add(ret, 0x80000000);
    label("native");
  }
  for (const [index, syscall] of [abi.setns, abi.ptrace, abi.writev, abi.pidfdSignal, abi.pidfdGetfd].entries()) {
    add(equal, syscall, "deny", `deny_next_${index}`); label(`deny_next_${index}`);
  }
  for (const [index, syscall] of abi.signals.entries()) {
    add(equal, syscall, "signal", `signal_next_${index}`); label(`signal_next_${index}`);
  }
  add(ret, 0x7fff0000); // ALLOW
  label("signal"); add(load, 16); // pid_t/tgid low 32 bits of args[0]
  // PID 1 and every process (-1) could reach the custodian. The fixed bootstrap
  // enters a verified distinct session before ACK, so current-group kill(0)
  // and other process groups retain normal timeout/CLI cancellation behavior.
  for (const [index, pid] of [1, 0xffffffff].entries()) {
    add(equal, pid, "deny", `pid_next_${index}`); label(`pid_next_${index}`);
  }
  add(ret, 0x7fff0000);
  label("deny"); add(ret, 0x00050001); // ERRNO(EPERM)
  const output = Buffer.alloc(instructions.length * 8);
  instructions.forEach((instruction, index) => {
    const jump = (target?: string) => {
      if (!target) return 0;
      const offset = labels.get(target)! - index - 1;
      if (!Number.isInteger(offset) || offset < 0 || offset > 255) throw new Error("Invalid workspace seccomp jump");
      return offset;
    };
    output.writeUInt16LE(instruction.code, index * 8);
    output.writeUInt8(jump(instruction.yes), index * 8 + 2);
    output.writeUInt8(jump(instruction.no), index * 8 + 3);
    output.writeUInt32LE(instruction.value, index * 8 + 4);
  });
  return output;
}
