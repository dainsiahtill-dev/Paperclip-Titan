import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

export type NamespaceObject = Readonly<{ device: string; inode: string }>;
export type ProvenanceOuterProcess = Readonly<{
  pid: number; start: string; bootId: string; uid: number; gid: number;
  userNamespace: NamespaceObject; pidNamespace: NamespaceObject; mountNamespace: NamespaceObject;
}>;
export type ProvenanceExpectedBinary = Readonly<{ device: string; inode: string; size: string; sha256: string }>;
export type ProvenanceMountEvidencePolicy = "statmount-unique-v1" | "kernel-mountinfo-idmapped-v1";
export type ProvenanceBinaryWitness = ProvenanceExpectedBinary & {
  uid: number; gid: number; mode: number; nlink: number; regular: true; mountId: string;
};
export type WorkspaceBinaryHostObservation = {
  version: 1; nonce: string; bootId: string; kernelCredentialScope: "kernel-validated-referenced-process";
  /** SCM permits capability-authorized substitution; these are validated claims, not actual sender identity. */
  kernelCredentialClaims: { pid: number; uid: number; gid: number };
  referencedProcess: { pid: number; start: string };
  outer: ProvenanceOuterProcess;
  namespaces: { user: NamespaceObject; pid: NamespaceObject; mount: NamespaceObject };
  root: NamespaceObject & { mountId: string };
  hostBinary: ProvenanceBinaryWitness; peerBinary: ProvenanceBinaryWitness;
  mountProof: { policy: ProvenanceMountEvidencePolicy; hostFilesystem: "ext4"; peerFilesystem: "ext4"; hostIdmapped: false; peerIdmapped: false };
  ancestry: { user: true; pid: true };
};
export type WorkspaceBinaryHelperRequest = Readonly<{
  nonce: string; socketPath: string; timeoutMs: number;
  outer: ProvenanceOuterProcess; expectedBinary: ProvenanceExpectedBinary;
  /** HOST-only admission for a known kernel contract; never select by guest or release string. */
  mountEvidencePolicy?: ProvenanceMountEvidencePolicy;
}>;
/** HOST closure only. A guest request never supplies observations, FDs, keys or paths. */
export interface WorkspaceBinaryHostTransport {
  readonly locator: string;
  observe(): Promise<WorkspaceBinaryHostObservation>;
  recheck(): Promise<WorkspaceBinaryHostObservation>;
  /** Resolves after same-claims ACK, mandatory HOST live-consumption check and full signed expiry pin custody.
   * The guest receives the proof earlier; the host result is an audit result.
   */
  deliver(proof: unknown, beforeConsumption: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

/** Fixed stdlib collector. No request-JSON PID/path/command; no signing key.
 * SCM may reference a substituted process under namespace capabilities. Facts
 * describe only that referenced process. Immutable consumer self/view checks
 * and HOST live bootstrap/challenge admission are mandatory before consumption.
 * Explicit HOST policy selects unique/statmount or known kernel mountinfo semantics.
 * Ordinary mount IDs require actual file/mount pins through full proof expiry.
 * POL-44 observations and a kernel release string are not admission substitutes.
 */
export const WORKSPACE_BINARY_PROVENANCE_PYTHON = String.raw`
import contextlib, ctypes, fcntl, hashlib, json, os, platform, select, signal, socket, stat, struct, sys, time

MAX_REQUEST = 1024
MAX_CONTROL = 16384
MAX_BINARY = 4 * 1024 * 1024
NS_GET_PARENT = 0xb702
REVOKED = False

def require(value, message):
    if not value:
        raise RuntimeError(message)

def decimal(value):
    return isinstance(value, str) and value.isascii() and value.isdecimal() and len(value) <= 24

def object_id(fd):
    st = os.fstat(fd)
    return {'device': str(st.st_dev), 'inode': str(st.st_ino)}

def require_host_observer(fd):
    # FD3 is opened by the host launcher, not selected or supplied by a guest.
    require(fcntl.ioctl(fd, 0xb703) == 0x10000000, 'observer_namespace_fd_invalid')
    current = os.open('/proc/self/ns/user', os.O_RDONLY | os.O_CLOEXEC)
    try: require(object_id(current) == object_id(fd), 'observer_namespace_changed')
    finally: os.close(current)
    require(open('/proc/self/uid_map').read(128).split() == ['0','0','4294967295'], 'observer_user_namespace_unsupported')

def process_start(pid):
    data = open('/proc/%d/stat' % pid).read(4096)
    fields = data[data.rfind(')') + 2:].split()
    require(len(fields) > 19 and fields[0] not in ('Z', 'X'), 'process_dead')
    return fields[19]

def boot_id():
    return open('/proc/sys/kernel/random/boot_id').read(128).strip()

def require_alive(pidfd):
    poll = select.poll()
    poll.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
    require(not poll.poll(0), 'process_dead_or_reused')

def namespace_descends(fd, outer):
    cursor = os.dup(fd)
    try:
        for _ in range(32):
            if object_id(cursor) == outer:
                return True
            parent = fcntl.ioctl(cursor, NS_GET_PARENT)
            os.close(cursor)
            cursor = parent
        raise RuntimeError('namespace_ancestry_unsupported')
    finally:
        os.close(cursor)

def decode_message(data, ancillary, flags, nonce, acknowledge=False):
    require(not flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC), 'request_truncated')
    require(0 < len(data) <= MAX_REQUEST, 'request_size')
    require(len(ancillary) == 1, 'request_credentials_count')
    level, kind, credentials = ancillary[0]
    require(level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(credentials) == struct.calcsize('3i'), 'request_ancillary_unsupported')
    pid, uid, gid = struct.unpack('3i', credentials)
    require(pid > 0 and uid >= 0 and gid >= 0, 'request_credentials_invalid')
    def unique(items):
        require(len(items) == len({key for key, _ in items}), 'request_duplicate_fields')
        return dict(items)
    body = json.loads(data.decode('ascii'), object_pairs_hook=unique)
    expected = {'version','nonce','ack'} if acknowledge else {'version','nonce'}
    require(isinstance(body, dict) and set(body) == expected, 'request_fields_unsupported')
    require(type(body['version']) is int and body['version'] == 1 and body['nonce'] == nonce, 'request_nonce_or_version')
    require(not acknowledge or body['ack'] is True, 'request_ack_invalid')
    return pid, uid, gid

def decode_request(data, ancillary, flags, nonce):
    return decode_message(data, ancillary, flags, nonce)

def receive_message(conn, nonce, acknowledge=False):
    data, ancillary, flags, _ = conn.recvmsg(MAX_REQUEST + 1, socket.CMSG_SPACE(struct.calcsize('3i')))
    try:
        return decode_message(data, ancillary, flags, nonce, acknowledge)
    finally:
        # SCM_RIGHTS may already have installed descriptors even on a rejected request.
        for level, kind, value in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                for offset in range(0, len(value) - (len(value) % 4), 4):
                    try: os.close(struct.unpack_from('i', value, offset)[0])
                    except OSError: pass

def receive_request(conn, nonce):
    return receive_message(conn, nonce)

def validate_binary_stat(st):
    require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == 0, 'binary_type_link_or_owner')
    mode = stat.S_IMODE(st.st_mode)
    require(not mode & 0o7022 and mode & 0o111 and 0 < st.st_size <= MAX_BINARY, 'binary_permissions_or_size')

def same_file_stat(before, after):
    require(all(getattr(before, key) == getattr(after, key) for key in ('st_mode','st_uid','st_gid','st_nlink','st_size','st_dev','st_ino','st_mtime_ns','st_ctime_ns')), 'binary_changed')

def hash_file(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = os.read(fd, 65536)
        if not chunk: break
        total += len(chunk)
        require(total <= MAX_BINARY, 'binary_size')
        digest.update(chunk)
    return digest.hexdigest()

def mount_id(fd, unique):
    # Linux UAPI: statx is fixed 256 bytes; stx_mnt_id is at 0x90.
    # Require unique (non-recycled) mount IDs, introduced with statmount.
    libc = ctypes.CDLL(None, use_errno=True)
    require(hasattr(libc, 'statx') and platform.machine() in ('x86_64','aarch64'), 'mount_platform_unsupported')
    info = ctypes.create_string_buffer(256)
    mask = 0x4000 if unique else 0x1000
    if libc.statx(ctypes.c_int(fd), ctypes.c_char_p(b''), ctypes.c_int(0x1000), ctypes.c_uint(mask), ctypes.byref(info)) != 0:
        raise RuntimeError('mount_statx_unsupported')
    require(struct.unpack_from('I', info.raw, 0)[0] & mask, 'mount_unique_id_unsupported' if unique else 'mount_id_unsupported')
    mount_id = struct.unpack_from('Q', info.raw, 0x90)[0]
    require(mount_id != 0, 'mount_id_unverified')
    return mount_id

def unique_mount_id(fd):
    return mount_id(fd, True)

def mount_witness(fd):
    mount_id = unique_mount_id(fd)
    libc = ctypes.CDLL(None, use_errno=True)
    # struct mnt_id_req v0. statmount is syscall 457 on these two supported ABIs.
    request = ctypes.create_string_buffer(struct.pack('IIQQ', 24, 0, mount_id, 0x22), 24)
    result = ctypes.create_string_buffer(4096)
    if libc.syscall(ctypes.c_long(457), ctypes.byref(request), ctypes.byref(result), ctypes.c_size_t(4096), ctypes.c_uint(0)) != 0:
        raise RuntimeError('mount_statmount_unsupported')
    data = result.raw
    used = struct.unpack_from('I', data, 0)[0]
    mask = struct.unpack_from('Q', data, 8)[0]
    require(512 <= used <= 4096 and mask & 0x22 == 0x22, 'mount_result_unverified')
    require(struct.unpack_from('Q', data, 40)[0] == mount_id, 'mount_id_changed')
    attributes = struct.unpack_from('Q', data, 64)[0]
    require(not attributes & 0x00100000, 'mount_idmapped_unsupported')
    offset = struct.unpack_from('I', data, 36)[0] + 512
    require(512 <= offset < used, 'mount_filesystem_unverified')
    end = data.find(b'\0', offset, used)
    require(end >= 0, 'mount_filesystem_unverified')
    filesystem = data[offset:end].decode('ascii')
    require(filesystem == 'ext4', 'mount_filesystem_unsupported')
    return {'mountId': str(mount_id), 'filesystem': filesystem, 'idmapped': False}

def parse_mountinfo(data, fd, expected_id):
    require(0 < len(data) <= 524288, 'mountinfo_size_unsupported')
    matches = []
    for line in data.splitlines():
        fields = line.split(' - ')
        require(len(fields) == 2, 'mountinfo_format_unsupported')
        left, right = fields[0].split(), fields[1].split()
        require(len(left) >= 6 and len(right) == 3, 'mountinfo_format_unsupported')
        require(left[0].isdecimal(), 'mountinfo_format_unsupported')
        if int(left[0]) == expected_id: matches.append((left,right))
    require(len(matches) == 1, 'mountinfo_identity_ambiguous')
    left, right = matches[0]
    options = left[5].split(',') + left[6:] + right[2].split(',')
    require('idmapped' not in options, 'mount_idmapped_unsupported')
    known = {'ro','rw','nosuid','nodev','noexec','noatime','nodiratime','relatime','strictatime','lazytime','nosymfollow'}
    require(all(option in known for option in left[5].split(',')), 'mount_options_unsupported')
    require(all(option == 'unbindable' or any(option.startswith(prefix) and option[len(prefix):].isdecimal() for prefix in ('shared:','master:','propagate_from:')) for option in left[6:]), 'mount_optional_fields_unsupported')
    require(right[0] == 'ext4', 'mount_filesystem_unsupported')
    st = os.fstat(fd)
    require(left[2] == '%d:%d' % (os.major(st.st_dev),os.minor(st.st_dev)), 'mount_device_changed')
    libc = ctypes.CDLL(None, use_errno=True)
    filesystem = ctypes.create_string_buffer(256)
    require(libc.fstatfs(ctypes.c_int(fd),ctypes.byref(filesystem)) == 0, 'mount_fstatfs_unsupported')
    require(ctypes.c_long.from_buffer(filesystem).value == 0xef53, 'mount_filesystem_unsupported')
    require(mount_id(fd,False) == expected_id, 'mount_id_changed_or_pin_closed')
    return {'mountId':str(expected_id),'filesystem':'ext4','idmapped':False}

def mountinfo_witness(fd, pid, namespace):
    # Open via the producer's own trusted procfs. NEVER /proc/<peer>/root/proc.
    current = os.open('/proc/%d/ns/mnt' % pid, os.O_RDONLY | os.O_CLOEXEC)
    try: require(object_id(current) == object_id(namespace), 'mount_namespace_changed')
    finally: os.close(current)
    # Explicit operator admission owns kernel semantics: the reviewed matching
    # WSL6.6 source prints idmapped in per-mount options. No uname-based trust.
    # Actual open file FDs hold vfsmount refs until the entire proof lifetime.
    expected = mount_id(fd,False)
    info = os.open('/proc/%d/mountinfo' % pid, os.O_RDONLY | os.O_CLOEXEC)
    try:
        poll = select.poll(); poll.register(info,select.POLLPRI | select.POLLERR)
        def read_snapshot():
            os.lseek(info,0,os.SEEK_SET)
            data = b''
            while True:
                part = os.read(info,65536)
                if not part: break
                data += part
                require(len(data) <= 524288, 'mountinfo_size_unsupported')
            return data.decode('ascii')
        first = read_snapshot()
        require(not poll.poll(0), 'mountinfo_changed')
        require(first == read_snapshot() and not poll.poll(0), 'mountinfo_changed')
        result = parse_mountinfo(first,fd,expected)
        current = os.open('/proc/%d/ns/mnt' % pid, os.O_RDONLY | os.O_CLOEXEC)
        try: require(object_id(current) == object_id(namespace), 'mount_namespace_changed')
        finally: os.close(current)
        require(not poll.poll(0), 'mountinfo_changed')
        return result
    finally: os.close(info)

def file_witness(fd, policy='statmount-unique-v1', pid=None, namespace=None):
    before = os.fstat(fd)
    validate_binary_stat(before)
    digest = hash_file(fd)
    require(policy in ('statmount-unique-v1','kernel-mountinfo-idmapped-v1'), 'mount_policy_unadmitted')
    mount = mount_witness(fd) if policy == 'statmount-unique-v1' else mountinfo_witness(fd,pid,namespace)
    same_file_stat(before, os.fstat(fd))
    return {'device':str(before.st_dev),'inode':str(before.st_ino),'size':str(before.st_size),'sha256':digest,
            'uid':before.st_uid,'gid':before.st_gid,'mode':stat.S_IMODE(before.st_mode),'nlink':before.st_nlink,'regular':True,'mountId':mount['mountId']}, mount

def open_binary(root, stack):
    cursor = root
    for name in ('usr','bin'):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=cursor)
        stack.callback(os.close, fd)
        st = os.fstat(fd)
        require(st.st_uid == 0 and not stat.S_IMODE(st.st_mode) & 0o022, 'binary_directory_untrusted')
        cursor = fd
    fd = os.open('bwrap', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=cursor)
    stack.callback(os.close, fd)
    validate_binary_stat(os.fstat(fd))
    return fd

def pin_process(pid, start, stack):
    require(type(pid) is int and pid > 0 and decimal(start), 'process_pin_invalid')
    before = process_start(pid)
    require(before == start, 'process_start_changed')
    fd = os.pidfd_open(pid, 0)
    stack.callback(os.close, fd)
    require_alive(fd)
    require(process_start(pid) == before, 'process_start_changed')
    return fd

def namespace_pins(pid, stack):
    result = {}
    for name in ('user','pid','mnt'):
        fd = os.open('/proc/%d/ns/%s' % (pid,name), os.O_RDONLY | os.O_CLOEXEC)
        stack.callback(os.close, fd)
        result[name] = fd
    return result

def check_process(pid, start, pidfd, namespaces, stack):
    require_alive(pidfd)
    require(process_start(pid) == start, 'process_start_changed')
    current = namespace_pins(pid, stack)
    require(all(object_id(current[name]) == object_id(namespaces[name]) for name in current), 'process_namespace_changed')

class Collection:
    def __init__(self, config, credentials, stack):
        self.config, self.stack = config, stack
        self.pid, self.uid, self.gid = credentials
        outer = config['outer']
        require(boot_id() == outer['bootId'], 'boot_changed')
        require(self.uid == outer['uid'] and self.gid == outer['gid'], 'peer_credentials_changed')
        self.outer_pidfd = pin_process(outer['pid'], outer['start'], stack)
        self.outer_ns = namespace_pins(outer['pid'], stack)
        for name, key in (('user','userNamespace'),('pid','pidNamespace'),('mnt','mountNamespace')):
            require(object_id(self.outer_ns[name]) == outer[key], 'outer_namespace_changed')
        self.start = process_start(self.pid)
        self.pidfd = pin_process(self.pid, self.start, stack)
        self.ns = namespace_pins(self.pid, stack)
        self.host_mount_ns = os.open('/proc/self/ns/mnt',os.O_RDONLY | os.O_CLOEXEC)
        stack.callback(os.close,self.host_mount_ns)
        for name in ('user','pid'):
            require(namespace_descends(self.ns[name], object_id(self.outer_ns[name])), 'peer_ancestry_unverified')
        self.root = os.open('/proc/%d/root' % self.pid, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        stack.callback(os.close, self.root)
        self.unique = config['mountEvidencePolicy'] == 'statmount-unique-v1'
        self.root_mount_id = mount_id(self.root,self.unique)
        host_root = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        stack.callback(os.close, host_root)
        self.host_binary = open_binary(host_root, stack)
        self.peer_binary = open_binary(self.root, stack)
        self.host_stat, self.peer_stat = os.fstat(self.host_binary), os.fstat(self.peer_binary)
        self.initial = self.observe()

    def observe(self):
        config, stack, outer = self.config, self.stack, self.config['outer']
        require(boot_id() == outer['bootId'], 'boot_changed')
        check_process(outer['pid'], outer['start'], self.outer_pidfd, self.outer_ns, stack)
        check_process(self.pid, self.start, self.pidfd, self.ns, stack)
        root = os.open('/proc/%d/root' % self.pid, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        stack.callback(os.close, root)
        require(object_id(root) == object_id(self.root) and mount_id(root,self.unique) == self.root_mount_id, 'peer_root_changed')
        # Reopen the canonical pathname, rejecting a later replacement/link.
        reopened = open_binary(root, stack)
        host_root = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        stack.callback(os.close, host_root)
        reopened_host = open_binary(host_root, stack)
        same_file_stat(self.host_stat, os.fstat(self.host_binary))
        same_file_stat(self.peer_stat, os.fstat(self.peer_binary))
        same_file_stat(os.fstat(self.host_binary), os.fstat(reopened_host))
        same_file_stat(os.fstat(self.peer_binary), os.fstat(reopened))
        policy = config['mountEvidencePolicy']
        host, hm = file_witness(self.host_binary,policy,os.getpid(),self.host_mount_ns)
        peer, pm = file_witness(self.peer_binary,policy,self.pid,self.ns['mnt'])
        require(file_witness(reopened,policy,self.pid,self.ns['mnt'])[0] == peer and file_witness(reopened_host,policy,os.getpid(),self.host_mount_ns)[0] == host, 'binary_path_changed')
        expected = config['expectedBinary']
        require(all(host[key] == expected[key] == peer[key] for key in ('device','inode','size','sha256')), 'binary_identity_changed')
        result = {'version':1,'nonce':config['nonce'],'bootId':outer['bootId'],'kernelCredentialScope':'kernel-validated-referenced-process',
                  'kernelCredentialClaims':{'pid':self.pid,'uid':self.uid,'gid':self.gid},
                  'referencedProcess':{'pid':self.pid,'start':self.start},'outer':outer,
                  'namespaces':{'user':object_id(self.ns['user']),'pid':object_id(self.ns['pid']),'mount':object_id(self.ns['mnt'])},
                  'root':{**object_id(root),'mountId':str(self.root_mount_id)},'hostBinary':host,'peerBinary':peer,
                  'mountProof':{'policy':policy,'hostFilesystem':hm['filesystem'],'peerFilesystem':pm['filesystem'],'hostIdmapped':False,'peerIdmapped':False},
                  'ancestry':{'user':True,'pid':True}}
        require(not hasattr(self, 'initial') or result == self.initial, 'observation_changed')
        # Hashing did not freeze a process/namespace. Check them again.
        check_process(outer['pid'], outer['start'], self.outer_pidfd, self.outer_ns, stack)
        check_process(self.pid, self.start, self.pidfd, self.ns, stack)
        final_root = os.open('/proc/%d/root' % self.pid,os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        stack.callback(os.close,final_root)
        require(object_id(final_root) == object_id(self.root) and mount_id(final_root,self.unique) == self.root_mount_id, 'peer_root_changed')
        require(boot_id() == outer['bootId'], 'boot_changed')
        return result

def control():
    line = sys.stdin.buffer.readline(MAX_CONTROL + 1)
    require(0 < len(line) <= MAX_CONTROL and line.endswith(b'\n'), 'host_control_size')
    result = json.loads(line)
    require(isinstance(result, dict), 'host_control_invalid')
    return result

def emit(event, **value):
    print(json.dumps({'event':event, **value}, separators=(',',':')), flush=True)

def main():
    config = control()
    require(set(config) == {'nonce','socketPath','timeoutMs','outer','expectedBinary','mountEvidencePolicy'}, 'host_config_fields')
    require(config['mountEvidencePolicy'] in ('statmount-unique-v1','kernel-mountinfo-idmapped-v1'), 'mount_policy_unadmitted')
    require(isinstance(config['nonce'],str) and len(config['nonce']) == 64 and all(c in '0123456789abcdef' for c in config['nonce']), 'host_nonce_invalid')
    require(type(config['timeoutMs']) is int and 1 <= config['timeoutMs'] <= 5000, 'host_timeout_invalid')
    def timed_out(*_): raise RuntimeError('request_expired')
    signal.signal(signal.SIGALRM, timed_out)
    def aborted(*_):
        global REVOKED
        REVOKED = True
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise RuntimeError('request_aborted')
    signal.signal(signal.SIGTERM, aborted)
    signal.setitimer(signal.ITIMER_REAL, config['timeoutMs'] / 1000)
    # This collector must run in the trusted host UID view, not inside a guest.
    require_host_observer(3)
    locator = config['socketPath']
    require(isinstance(locator,str) and os.path.isabs(locator) and len(os.fsencode(locator)) <= 103 and '\n' not in locator, 'host_locator_invalid')
    parent = os.path.dirname(locator)
    require(os.path.realpath(parent) == parent, 'host_locator_parent_changed')
    parent_stat = os.stat(parent)
    require(parent_stat.st_uid == os.geteuid() and not stat.S_IMODE(parent_stat.st_mode) & 0o022, 'host_locator_parent_untrusted')
    os.umask(0o077)
    with contextlib.ExitStack() as stack:
        stack.callback(os.close, 3)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        stack.callback(server.close)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        server.bind(locator)
        socket_stat = os.lstat(locator)
        def remove_socket():
            try:
                current = os.lstat(locator)
                if (current.st_dev,current.st_ino) == (socket_stat.st_dev,socket_stat.st_ino): os.unlink(locator)
            except FileNotFoundError: pass
        stack.callback(remove_socket)
        server.listen(1)
        emit('ready', locator=locator)
        conn, _ = server.accept()
        stack.callback(conn.close)
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        credentials = receive_request(conn, config['nonce'])
        server.close() # Exactly one credential-referenced subject/request; no retry.
        collection = Collection(config, credentials, stack)
        emit('observed', observation=collection.initial)
        require(control() == {'command':'recheck'}, 'host_command_invalid')
        emit('rechecked', observation=collection.observe())
        response = control()
        require(set(response) == {'command','proof'} and response['command'] == 'deliver', 'host_command_invalid')
        collection.observe()
        payload = response['proof']['payload']
        require(payload['nonce'] == config['nonce'] and type(payload['issuedAt']) is int and type(payload['expiresAt']) is int, 'host_proof_invalid')
        lifetime = payload['expiresAt'] - payload['issuedAt']
        require(0 < lifetime <= 1000 and time.time()*1000 < payload['expiresAt'], 'host_proof_expired')
        # Keep every pidfd/namespace/root/file/vfsmount pin through FULL signed
        # acceptance lifetime, even after a same-claims ACK. ACK is not release.
        hold_until = time.monotonic() + lifetime / 1000
        data = json.dumps(response['proof'], separators=(',',':')).encode('ascii')
        require(len(data) <= MAX_CONTROL, 'host_proof_size')
        require(conn.send(data) == len(data), 'response_truncated')
        emit('delivered')
        try:
            ack = receive_message(conn, config['nonce'],True)
            require(ack == credentials, 'ack_peer_changed')
            collection.observe()
            require(time.time()*1000 < payload['expiresAt'], 'host_proof_expired')
            # ACK claims cannot authenticate a sender. Only HOST admission of
            # immutable consumer self/view comparison + live nonce context can.
            emit('acknowledged')
            require(control() == {'command':'consume'}, 'host_consumption_unadmitted')
            collection.observe()
            require(time.time()*1000 < payload['expiresAt'], 'host_proof_expired')
            confirmed = json.dumps({'version':1,'nonce':config['nonce'],'consumed':True},separators=(',',':')).encode('ascii')
            require(conn.send(confirmed) == len(confirmed), 'response_truncated')
            emit('accepted')
        finally:
            # A malformed/early ACK or peer EOF does NOT release mounts while
            # a signature can still be accepted. Explicit host revocation does.
            while not REVOKED and time.monotonic() < hold_until:
                time.sleep(min(0.01,max(0,hold_until-time.monotonic())))
        emit('released')

if __name__ == '__main__':
    try: main()
    except Exception as error:
        emit('error', code=str(error)[:160])
        sys.exit(1)
`;

/** Only invoked explicitly by a host controller. Existing startup never loads it. */
export async function startWorkspaceBinaryProvenanceHelper(
  request: WorkspaceBinaryHelperRequest, signal: AbortSignal,
): Promise<WorkspaceBinaryHostTransport> {
  signal.throwIfAborted();
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 5000)
    throw new Error("workspace_binary_helper_timeout_invalid");
  const observerPin = await open("/proc/self/ns/user", constants.O_RDONLY);
  let child: ReturnType<typeof spawn>;
  try {
    signal.throwIfAborted();
    child = spawn("/usr/bin/python3", ["-I", "-u", "-c", WORKSPACE_BINARY_PROVENANCE_PYTHON], {
      stdio: ["pipe", "pipe", "pipe", observerPin.fd], env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, cwd: "/",
    });
  } catch (error) { await observerPin.close(); throw error; }
  // The helper now holds the kernel object through its inherited FD3.
  const observerClosed = observerPin.close();
  const queue: Array<Record<string, unknown>> = [];
  const waiters: Array<{ resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }> = [];
  let failure: Error | undefined;
  let closed = false;
  let terminationSent = false;
  let stderrBytes = 0;
  let stdoutBytes = 0;
  const stopChild = () => {
    if (!closed && !terminationSent) { terminationSent = true; child.kill("SIGTERM"); }
  };
  const fail = (error: Error) => {
    failure ??= error;
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
    stopChild();
  };
  const exited = new Promise<void>(resolve => child.once("close", () => {
    closed = true;
    if (!failure) fail(new Error("workspace_binary_helper_closed"));
    resolve();
  }));
  child.on("error", error => fail(error));
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 4096) fail(new Error("workspace_binary_helper_stderr_size"));
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 32768) fail(new Error("workspace_binary_helper_stdout_size"));
  });
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  lines.on("line", line => {
    if (failure) return;
    try {
      if (Buffer.byteLength(line) > 16384) throw new Error("workspace_binary_helper_message_size");
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.event === "error") throw new Error(`workspace_binary_helper_rejected:${String(message.code)}`);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message); else if (queue.length < 4) queue.push(message);
      else throw new Error("workspace_binary_helper_message_count");
    } catch (error) { fail(error instanceof Error ? error : new Error("workspace_binary_helper_protocol")); }
  });
  const next = (event: string) => (failure ? Promise.reject(failure) : queue.length
    ? Promise.resolve(queue.shift()!)
    : new Promise<Record<string, unknown>>((resolve, reject) => waiters.push({ resolve, reject })))
    .then(message => {
      if (message.event !== event) throw new Error("workspace_binary_helper_protocol");
      signal.throwIfAborted();
      return message;
    });
  const abort = () => fail(new Error("workspace_binary_helper_aborted"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => fail(new Error("workspace_binary_helper_expired")), request.timeoutMs);
  const send = (value: unknown) => {
    signal.throwIfAborted();
    if (failure) throw failure;
    const data = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(data) > 16384) throw new Error("workspace_binary_helper_control_size");
    child.stdin!.write(data);
  };
  child.stdin!.on("error", error => fail(error));
  let cleanup: Promise<void> | undefined;
  const close = () => cleanup ??= (async () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (!closed) {
      stopChild();
      const kill = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 100);
      await exited;
      clearTimeout(kill);
    }
    lines.close();
    child.stdin!.destroy();
    await observerClosed;
  })();
  try {
    send({ ...request, mountEvidencePolicy: request.mountEvidencePolicy ?? "statmount-unique-v1" });
    const ready = await next("ready");
    if (ready.locator !== request.socketPath) throw new Error("workspace_binary_helper_locator_changed");
    return {
      locator: request.socketPath,
      observe: async () => (await next("observed")).observation as WorkspaceBinaryHostObservation,
      recheck: async () => { send({ command: "recheck" }); return (await next("rechecked")).observation as WorkspaceBinaryHostObservation; },
      deliver: async (proof, beforeConsumption) => {
        if (typeof beforeConsumption !== "function") throw new Error("workspace_binary_helper_consumption_unadmitted");
        send({ command: "deliver", proof });
        await next("delivered");
        await next("acknowledged");
        await beforeConsumption();
        send({ command: "consume" });
        await next("accepted");
        await next("released");
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
