# Seccomp Profile for NanoClaw Containers

**Purpose:** Restrict system calls available to containerized agents, preventing kernel-level exploits and privilege escalation.

## What is Seccomp?

Seccomp (Secure Computing Mode) is a Linux kernel feature that filters system calls. By default, this profile **blocks** all syscalls except those explicitly allowed.

## Blocked Syscalls (Security Critical)

The following dangerous syscalls are **NOT** in the allowlist and will return `EPERM` if attempted:

### Container Escape / Privilege Escalation

- `mount`, `umount`, `umount2` - Mount filesystem (container escape)
- `pivot_root` - Change root filesystem (container escape)
- `chroot` - Change root directory (can escape container)
- `unshare` - Create new namespaces (namespace manipulation)
- `setns` - Join existing namespace (namespace manipulation)
- `clone3` - Advanced process creation (can bypass restrictions)

### Kernel Module Loading

- `init_module`, `finit_module` - Load kernel modules
- `delete_module` - Unload kernel modules
- **Why blocked:** Could load malicious kernel code, full system compromise

### System Configuration

- `sethostname`, `setdomainname` - Change system identity
- `settimeofday`, `clock_settime` - Modify system time
- `swapon`, `swapoff` - Manage swap
- `reboot` - Reboot system
- `kexec_load`, `kexec_file_load` - Load new kernel

### Advanced Security Bypasses

- `ptrace` - Debug other processes (can inject code)
- `process_vm_readv`, `process_vm_writev` - Read/write other process memory
- `perf_event_open` - Performance monitoring (side-channel attacks)
- `bpf` - Berkeley Packet Filter (can hook kernel)
- `userfaultfd` - Page fault handling (timing attacks)

### Quota & Resource Manipulation

- `quotactl` - Manage disk quotas
- `lookup_dcookie` - Dcache manipulation

### Keyring & Credentials

- `keyctl` - Kernel keyring (credential storage)
- `add_key`, `request_key` - Keyring operations
- **Why blocked:** Could access other users' keys

### Hardware Access

- `ioperm`, `iopl` - I/O port permissions
- `create_module`, `query_module`, `get_kernel_syms` - Kernel internals

### Obscure/Deprecated

- `afs_syscall`, `security`, `tuxcall` - Unused/deprecated
- `vserver` - Linux-VServer (deprecated virtualization)

## Allowed Syscalls (Safe Operations)

The profile allows **~240 syscalls** that are safe for normal application execution:

### File Operations
- `open`, `read`, `write`, `close`, `stat`, `fstat`, `lstat`
- `mkdir`, `rmdir`, `unlink`, `rename`, `link`, `symlink`
- `chmod`, `chown`, `truncate`, `fcntl`

### Process Management
- `fork`, `vfork`, `execve`, `exit`, `wait4`, `kill`
- `getpid`, `getppid`, `getuid`, `getgid`
- `setuid`, `setgid` (for privilege dropping)

### Networking
- `socket`, `bind`, `connect`, `listen`, `accept`
- `send`, `recv`, `sendto`, `recvfrom`
- `getsockopt`, `setsockopt`

### Memory Management
- `mmap`, `munmap`, `mprotect`, `brk`
- `madvise`, `mlock`, `munlock`

### Time & Scheduling
- `nanosleep`, `clock_gettime`, `gettimeofday`
- `sched_yield`, `sched_setscheduler`

### IPC (Inter-Process Communication)
- `pipe`, `eventfd`, `futex`
- `semget`, `semop`, `msgget`, `shmget`

### Signals
- `rt_sigaction`, `rt_sigprocmask`, `kill`, `tkill`

## Testing Blocked Syscalls

To verify the seccomp profile is working:

```bash
# Inside container, try blocked syscall
$ sudo mount /dev/sda1 /mnt
# Should fail with: Operation not permitted (EPERM)

# Try allowed syscall
$ mkdir /tmp/test
# Should succeed
```

## Performance Impact

- **Overhead:** < 1% CPU (syscall filtering happens in kernel)
- **Memory:** Negligible (~few KB for filter BPF program)
- **Latency:** Sub-microsecond per syscall

## Apple Container Compatibility

Apple Container uses macOS's Virtualization.framework under the hood. Seccomp profiles are applied **inside the Linux VM** that runs per container.

**Implementation:**
- Copy `seccomp-profile.json` to container at build time
- Apply with `--security-opt seccomp=/path/to/profile.json` at runtime

## References

- [Docker Seccomp Documentation](https://docs.docker.com/engine/security/seccomp/)
- [Linux Seccomp(2) Manual](https://man7.org/linux/man-pages/man2/seccomp.2.html)
- [Kubernetes Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
