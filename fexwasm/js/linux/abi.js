// x86-64 Linux ABI constants for the guest kernel (js/linux/kernel.js).
'use strict';

const SYS = {
  read: 0, write: 1, open: 2, close: 3, stat: 4, fstat: 5, lstat: 6, poll: 7, lseek: 8, mmap: 9, mprotect: 10, munmap: 11,
  brk: 12, rt_sigaction: 13, rt_sigprocmask: 14, rt_sigreturn: 15, ioctl: 16, pread64: 17, pwrite64: 18, readv: 19,
  writev: 20, access: 21, pipe: 22, select: 23, sched_yield: 24, mremap: 25, msync: 26, mincore: 27, madvise: 28,
  dup: 32, dup2: 33, pause: 34, nanosleep: 35, getitimer: 36, alarm: 37, setitimer: 38, getpid: 39, sendfile: 40,
  socket: 41, connect: 42, accept: 43, sendto: 44, recvfrom: 45, sendmsg: 46, recvmsg: 47, shutdown: 48, bind: 49,
  listen: 50, getsockname: 51, getpeername: 52, socketpair: 53, setsockopt: 54, getsockopt: 55, clone: 56, fork: 57,
  vfork: 58, execve: 59, exit: 60, wait4: 61, kill: 62, uname: 63, fcntl: 72, flock: 73, fsync: 74, fdatasync: 75,
  truncate: 76, ftruncate: 77, getdents: 78, getcwd: 79, chdir: 80, fchdir: 81, rename: 82, mkdir: 83, rmdir: 84,
  creat: 85, link: 86, unlink: 87, symlink: 88, readlink: 89, chmod: 90, fchmod: 91, chown: 92, fchown: 93, lchown: 94,
  umask: 95, gettimeofday: 96, getrlimit: 97, getrusage: 98, sysinfo: 99, times: 100, getuid: 102, getgid: 104,
  setuid: 105, setgid: 106, geteuid: 107, getegid: 108, setpgid: 109, getppid: 110, getpgrp: 111, setsid: 112,
  setreuid: 113, setregid: 114, getgroups: 115, setgroups: 116, setresuid: 117, getresuid: 118, setresgid: 119,
  getresgid: 120, getpgid: 121, getsid: 124, capget: 125, rt_sigpending: 127, rt_sigtimedwait: 128,
  rt_sigqueueinfo: 129, rt_sigsuspend: 130, sigaltstack: 131, utime: 132, mknod: 133, personality: 135, statfs: 137,
  fstatfs: 138, getpriority: 140, setpriority: 141, sched_setparam: 142, sched_getparam: 143, sched_setscheduler: 144,
  sched_getscheduler: 145, sched_get_priority_max: 146, sched_get_priority_min: 147, mlock: 149, munlock: 150,
  prctl: 157, arch_prctl: 158, setrlimit: 160, sync: 162, gettid: 186, readahead: 187, getxattr: 191, lgetxattr: 192,
  fgetxattr: 193, tkill: 200, time: 201, futex: 202, sched_setaffinity: 203, sched_getaffinity: 204,
  epoll_create: 213, getdents64: 217, set_tid_address: 218, restart_syscall: 219, fadvise64: 221, timer_create: 222,
  timer_settime: 223, timer_gettime: 224, timer_getoverrun: 225, timer_delete: 226, clock_settime: 227,
  clock_gettime: 228, clock_getres: 229, clock_nanosleep: 230, exit_group: 231, epoll_wait: 232, epoll_ctl: 233,
  tgkill: 234, utimes: 235, waitid: 247, inotify_init: 253, openat: 257, mkdirat: 258, mknodat: 259, fchownat: 260,
  newfstatat: 262, unlinkat: 263, renameat: 264, linkat: 265, symlinkat: 266, readlinkat: 267, fchmodat: 268,
  faccessat: 269, pselect6: 270, ppoll: 271, set_robust_list: 273, get_robust_list: 274, utimensat: 280,
  epoll_pwait: 281, signalfd: 282, timerfd_create: 283, eventfd: 284, fallocate: 285, timerfd_settime: 286,
  timerfd_gettime: 287, accept4: 288, signalfd4: 289, eventfd2: 290, epoll_create1: 291, dup3: 292, pipe2: 293,
  inotify_init1: 294, preadv: 295, pwritev: 296, rt_tgsigqueueinfo: 297, recvmmsg: 299, prlimit64: 302,
  sendmmsg: 307, getcpu: 309, renameat2: 316, getrandom: 318, memfd_create: 319, execveat: 322, membarrier: 324,
  copy_file_range: 326, preadv2: 327, pwritev2: 328, statx: 332, rseq: 334, pidfd_open: 434, clone3: 435,
  close_range: 436, openat2: 437, faccessat2: 439, epoll_pwait2: 441,
};
const SYS_NAME = Object.fromEntries(Object.entries(SYS).map(([k, v]) => [v, k]));

const E = {
  PERM: 1, NOENT: 2, SRCH: 3, INTR: 4, IO: 5, NXIO: 6, E2BIG: 7, NOEXEC: 8, BADF: 9, CHILD: 10, AGAIN: 11, NOMEM: 12,
  ACCES: 13, FAULT: 14, BUSY: 16, EXIST: 17, XDEV: 18, NODEV: 19, NOTDIR: 20, ISDIR: 21, INVAL: 22, NFILE: 23,
  MFILE: 24, NOTTY: 25, FBIG: 27, NOSPC: 28, SPIPE: 29, ROFS: 30, MLINK: 31, PIPE: 32, RANGE: 34, DEADLK: 35,
  NAMETOOLONG: 36, NOLCK: 37, NOSYS: 38, NOTEMPTY: 39, LOOP: 40, NODATA: 61, OVERFLOW: 75, NOTSOCK: 88,
  DESTADDRREQ: 89, MSGSIZE: 90, PROTOTYPE: 91, NOPROTOOPT: 92, PROTONOSUPPORT: 93, OPNOTSUPP: 95, AFNOSUPPORT: 97,
  ADDRINUSE: 98, ADDRNOTAVAIL: 99, CONNABORTED: 103, CONNRESET: 104, NOBUFS: 105, ISCONN: 106, NOTCONN: 107,
  TIMEDOUT: 110, CONNREFUSED: 111, ALREADY: 114, INPROGRESS: 115,
};

const O = {
  ACCMODE: 3, WRONLY: 1, RDWR: 2, CREAT: 0x40, EXCL: 0x80, NOCTTY: 0x100, TRUNC: 0x200, APPEND: 0x400,
  NONBLOCK: 0x800, DIRECTORY: 0x10000, NOFOLLOW: 0x20000, CLOEXEC: 0x80000, PATH: 0x200000, TMPFILE: 0x400000,
};
const AT = { FDCWD: -100, SYMLINK_NOFOLLOW: 0x100, REMOVEDIR: 0x200, SYMLINK_FOLLOW: 0x400, EMPTY_PATH: 0x1000 };
const PROT = { READ: 1, WRITE: 2, EXEC: 4 };
const MAP = { SHARED: 1, PRIVATE: 2, TYPE: 0xf, FIXED: 0x10, ANONYMOUS: 0x20, GROWSDOWN: 0x100, NORESERVE: 0x4000,
  POPULATE: 0x8000, STACK: 0x20000, FIXED_NOREPLACE: 0x100000 };
const CLONE = { VM: 0x100, FS: 0x200, FILES: 0x400, SIGHAND: 0x800, PIDFD: 0x1000, VFORK: 0x4000, PARENT: 0x8000,
  THREAD: 0x10000, SYSVSEM: 0x40000, SETTLS: 0x80000, PARENT_SETTID: 0x100000, CHILD_CLEARTID: 0x200000,
  CHILD_SETTID: 0x1000000 };
const SIG = { HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8, KILL: 9, USR1: 10, SEGV: 11, USR2: 12,
  PIPE: 13, ALRM: 14, TERM: 15, CHLD: 17, CONT: 18, STOP: 19, TSTP: 20, WINCH: 28, IO: 29, SYS: 31 };
const SA = { SIGINFO: 4, ONSTACK: 0x08000000, RESTART: 0x10000000, NODEFER: 0x40000000, RESETHAND: 0x80000000,
  RESTORER: 0x04000000 };
const S_IF = { MT: 0o170000, SOCK: 0o140000, LNK: 0o120000, REG: 0o100000, BLK: 0o060000, DIR: 0o040000,
  CHR: 0o020000, FIFO: 0o010000 };
const AUX = { NULL: 0, PHDR: 3, PHENT: 4, PHNUM: 5, PAGESZ: 6, BASE: 7, FLAGS: 8, ENTRY: 9, UID: 11, EUID: 12, GID: 13,
  EGID: 14, PLATFORM: 15, HWCAP: 16, CLKTCK: 17, SECURE: 23, RANDOM: 25, HWCAP2: 26, EXECFN: 31, MINSIGSTKSZ: 51 };

module.exports = { SYS, SYS_NAME, E, O, AT, PROT, MAP, CLONE, SIG, SA, S_IF, AUX };
