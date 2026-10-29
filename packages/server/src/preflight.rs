//! Can this machine run a master? (FR-20.13, plan step P1-2; the installers, AC 14)
//!
//! The installers run it before they install anything (the MSI through `msi.rs`, a custom action
//! that compiles this file into a DLL as it is; the .deb through `packaging/linux/preinst`, which
//! mirrors it in shell), `lgr-server preflight` runs it on demand, and the supervisor runs it before
//! it starts anything: a machine that fails is told why in words, instead of a `mongod` that dies of
//! SIGILL on its first instruction.
//!
//! ⚠ This file is a LEAF: nothing in it names `crate::`, because `msi.rs` compiles it on its own.
//!
//! - **CPU:** x86-64 with AVX, or ARMv8.2-A. MongoDB 5.0 and later will not start without it.
//! - **Memory and disk:** a machine with at least 4 GB of RAM (`MIN_USABLE_RAM` says what that reads
//!   as), and 20 GB free on the data volume. The installers' floor: the supervisor starts below it,
//!   and warns (`blocks_start`).
//! - **Where the data goes:** a local, fixed disk. Not a network share, a redirected path or a
//!   roaming profile: a database on any of those is lost, corrupted, or slow beyond use.
//! - **Windows only:** the VC++ runtime `mongod` links is where Windows loads it from: the package's
//!   `bin\`, which carries it app-local, or System32.
//! - **In a container** (FR-20.12, the image): the memory is the container's limit when it has one,
//!   and the data is on a volume, never on the container's own layer (overlayfs), which goes with it.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// A machine with 4 GB of RAM installed (FR-20.13).
pub const MIN_RAM: u64 = 4 << 30;
/// What the OS reports as usable on such a machine, at worst: firmware, an integrated GPU's shared
/// memory and the kernel keep some. ⚠ Never `MIN_RAM` itself: a 4 GB VM reads 3.8 GB, so measuring
/// against 4 GiB refused every 4 GB machine (the vmtest `master-ubuntu-4gb` lane, 2026-10-28), while
/// a 3 GB one still reads under this.
pub const MIN_USABLE_RAM: u64 = 13 << 28; // 3.25 GiB
pub const MIN_FREE_DISK: u64 = 20 << 30;

/// Where a master's data lives (FR-20.14), unless `LGR_SERVER_DATA` says otherwise: here, because the
/// installers measure it before anything else exists.
pub fn default_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        base.join("LGR")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/LGR")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        PathBuf::from("/var/lib/lgr")
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Check {
    pub name: &'static str,
    pub ok: bool,
    /// What was found, in words: shown to the person installing.
    pub detail: String,
}

fn check(name: &'static str, ok: bool, detail: impl Into<String>) -> Check {
    Check { name, ok, detail: detail.into() }
}

fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / (1u64 << 30) as f64)
}

/// The CPU features MongoDB's binaries are built for.
pub fn cpu() -> Check {
    #[cfg(target_arch = "x86_64")]
    {
        let avx = std::arch::is_x86_feature_detected!("avx");
        check("cpu", avx, if avx { "x86-64 with AVX" } else { "this x86-64 CPU has no AVX, which MongoDB 5.0 and later need" })
    }
    #[cfg(target_arch = "aarch64")]
    {
        // ARMv8.2-A made DC CVAP (`dpb`) mandatory: a Raspberry Pi 4 (Cortex-A72, ARMv8.0) lacks it,
        // a Pi 5 (Cortex-A76) has it.
        let v82 = std::arch::is_aarch64_feature_detected!("dpb");
        check("cpu", v82, if v82 { "ARMv8.2-A" } else { "this ARM CPU is older than ARMv8.2-A, which MongoDB 5.0 and later need" })
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        check("cpu", false, format!("{} is not a CPU MongoDB supports", std::env::consts::ARCH))
    }
}

/// Total physical memory, in bytes. On Linux, less when this process runs under a memory limit
/// (`cgroup_memory_limit`): that is all it will get.
pub fn total_ram() -> Option<u64> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        (GlobalMemoryStatusEx(&mut status) != 0).then_some(status.ullTotalPhys)
    }
    #[cfg(target_os = "linux")]
    {
        let machine = machine_ram()?;
        Some(cgroup_memory_limit().map_or(machine, |limit| limit.min(machine)))
    }
    #[cfg(target_os = "macos")]
    unsafe {
        let mut bytes: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        let name = b"hw.memsize\0";
        (libc::sysctlbyname(name.as_ptr() as *const _, &mut bytes as *mut u64 as *mut _, &mut len, std::ptr::null_mut(), 0) == 0)
            .then_some(bytes)
    }
}

/// What the kernel says the machine has (`MemTotal`), whatever this process may use of it.
#[cfg(target_os = "linux")]
fn machine_ram() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb: u64 = meminfo.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

/// The memory limit this process runs under, if it has one: a container's (`docker run --memory`,
/// a Kubernetes limit) or a unit's `MemoryMax=` (FR-20.12). ⚠ `/proc/meminfo` reports the MACHINE
/// whatever the limit: a master that sized `mongod`'s cache for a 32 GB host inside a 4 GB container
/// is killed by the kernel the first time that cache fills.
#[cfg(target_os = "linux")]
pub fn cgroup_memory_limit() -> Option<u64> {
    let cgroups = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    cgroup_limit(&cgroups, Path::new("/sys/fs/cgroup"))
}

/// The least limit from this process's cgroup up to `root` (`/proc/self/cgroup` says where it is): a
/// parent's binds too. cgroup v2 (`0::<path>`) reads `memory.max`, v1 the memory controller's
/// `memory.limit_in_bytes`. Inside a container its own cgroup is the top of what it sees.
#[cfg(any(target_os = "linux", test))]
fn cgroup_limit(proc_self_cgroup: &str, root: &Path) -> Option<u64> {
    let mut least: Option<u64> = None;
    for line in proc_self_cgroup.lines() {
        let mut fields = line.splitn(3, ':');
        let (Some(_), Some(controllers), Some(path)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let (top, file) = if controllers.is_empty() {
            (root.to_path_buf(), "memory.max")
        } else if controllers.split(',').any(|c| c == "memory") {
            (root.join("memory"), "memory.limit_in_bytes")
        } else {
            continue;
        };
        let mut dir = top.join(path.trim_start_matches('/'));
        while dir.starts_with(&top) {
            if let Some(limit) = limit_in(&dir.join(file)) {
                least = Some(least.map_or(limit, |l| l.min(limit)));
            }
            if dir == top || !dir.pop() {
                break;
            }
        }
    }
    least
}

/// A limit file's bytes. `max` (v2), and v1's "unlimited" (a number near `i64::MAX`), are no limit.
#[cfg(any(target_os = "linux", test))]
fn limit_in(file: &Path) -> Option<u64> {
    let bytes: u64 = std::fs::read_to_string(file).ok()?.trim().parse().ok()?;
    (bytes < 1 << 60).then_some(bytes)
}

pub fn memory() -> Check {
    #[cfg(target_os = "linux")]
    if let (Some(machine), Some(limit)) = (machine_ram(), cgroup_memory_limit()) {
        if limit < machine {
            return memory_under_limit(limit, machine);
        }
    }
    match total_ram() {
        Some(ram) => memory_of(ram),
        None => check("memory", false, "could not read the amount of RAM"),
    }
}

/// A process under a memory limit gets the limit, not the machine.
#[cfg(any(target_os = "linux", test))]
fn memory_under_limit(limit: u64, machine: u64) -> Check {
    check(
        "memory",
        limit >= MIN_USABLE_RAM,
        format!("{} of RAM usable: this server's memory limit (a container's, or its service's) on a machine with {} (a machine with {} is the least)", gb(limit), gb(machine), gb(MIN_RAM)),
    )
}

/// `ram` is what the OS reports as usable, which on a machine with 4 GB installed is never 4 GiB.
fn memory_of(ram: u64) -> Check {
    check("memory", ram >= MIN_USABLE_RAM, format!("{} of RAM usable (a machine with {} is the least)", gb(ram), gb(MIN_RAM)))
}

/// The nearest existing ancestor of `path`: the data directory may not exist yet on a first install.
fn existing(path: &Path) -> &Path {
    let mut p = path;
    while !p.exists() {
        match p.parent() {
            Some(parent) => p = parent,
            None => break,
        }
    }
    p
}

/// Free bytes on the volume holding `path`.
pub fn free_disk(path: &Path) -> Option<u64> {
    disk_space(path).map(|(free, _)| free)
}

/// The bytes free to this process on the volume holding `path`, and the volume's size: FR-20.101's
/// "disk below 10 %" needs both.
pub fn disk_space(path: &Path) -> Option<(u64, u64)> {
    let path = existing(path);
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let (mut free, mut total): (u64, u64) = (0, 0);
        (GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, std::ptr::null_mut()) != 0).then_some((free, total))
    }
    #[cfg(unix)]
    unsafe {
        let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).ok()?;
        let mut st: libc::statvfs = std::mem::zeroed();
        (libc::statvfs(c.as_ptr(), &mut st) == 0).then(|| (st.f_bavail as u64 * st.f_frsize as u64, st.f_blocks as u64 * st.f_frsize as u64))
    }
}

pub fn disk(data: &Path) -> Check {
    match free_disk(data) {
        Some(free) => check("disk", free >= MIN_FREE_DISK, format!("{} free for {} (at least {} needed)", gb(free), data.display(), gb(MIN_FREE_DISK))),
        None => check("disk", false, format!("could not read the free space for {}", data.display())),
    }
}

/// Why `data` is not a local, fixed disk, if it is not.
pub fn not_local(data: &Path) -> Option<String> {
    let text = data.to_string_lossy();
    if text.starts_with(r"\\") || text.starts_with("//") {
        return Some(format!("{} is a network path", data.display()));
    }
    #[cfg(windows)]
    {
        if let Some(roaming) = std::env::var_os("APPDATA") {
            if data.starts_with(&roaming) {
                return Some(format!("{} is in a roaming profile, which moves between machines", data.display()));
            }
        }
        unsafe {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
            let root: std::path::PathBuf = data.components().take(2).collect();
            let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
            // 2 removable, 4 remote (a mapped share, or SUBST over one), 5 CD-ROM, 6 RAM disk.
            match GetDriveTypeW(wide.as_ptr()) {
                2 => return Some(format!("{} is on a removable drive", data.display())),
                4 => return Some(format!("{} is on a network drive", data.display())),
                5 => return Some(format!("{} is on an optical drive", data.display())),
                6 => return Some(format!("{} is on a RAM disk, which does not survive a restart", data.display())),
                _ => {}
            }
        }
    }
    #[cfg(target_os = "linux")]
    unsafe {
        let c = std::ffi::CString::new(existing(data).as_os_str().as_encoded_bytes()).ok()?;
        let mut st: libc::statfs = std::mem::zeroed();
        if libc::statfs(c.as_ptr(), &mut st) == 0 {
            // NFS, SMB (old and CIFS), FUSE (sshfs and friends), tmpfs (gone at reboot), and overlayfs:
            // a container's own layer (FR-20.12: the image's data is a volume), or a live system's.
            match st.f_type as i64 {
                0x6969 => return Some(format!("{} is on NFS", data.display())),
                0x517B | 0xFF53_4D42 | 0xFE53_4D42 => return Some(format!("{} is on an SMB share", data.display())),
                0x6573_5546 => return Some(format!("{} is on a FUSE file system", data.display())),
                0x0102_1994 => return Some(format!("{} is on tmpfs, which does not survive a restart", data.display())),
                0x794C_7630 => return Some(format!("{} is on overlayfs, a container's own layer or a live system's, which does not keep it: mount a volume there", data.display())),
                _ => {}
            }
        }
    }
    #[cfg(target_os = "macos")]
    unsafe {
        let c = std::ffi::CString::new(existing(data).as_os_str().as_encoded_bytes()).ok()?;
        let mut st: libc::statfs = std::mem::zeroed();
        if libc::statfs(c.as_ptr(), &mut st) == 0 {
            let kind = std::ffi::CStr::from_ptr(st.f_fstypename.as_ptr()).to_string_lossy().into_owned();
            if ["nfs", "smbfs", "afpfs", "webdav", "osxfuse", "macfuse"].contains(&kind.as_str()) {
                return Some(format!("{} is on a {kind} network file system", data.display()));
            }
        }
    }
    None
}

pub fn location(data: &Path) -> Check {
    match not_local(data) {
        None => check("location", true, format!("{} is on a local, fixed disk", data.display())),
        Some(why) => check("location", false, why),
    }
}

/// The VC++ runtime `mongod.exe` links: what the package's `bin\` carries
/// (`scripts/assemble-server-home.ts`).
#[cfg(any(windows, test))]
const CRT: [&str; 3] = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

/// Each DLL counts where Windows loads it from: beside `mongod.exe` first, then System32.
///
/// ⚠ Never System32 alone. The package ships the runtime app-local, and a clean Windows has none in
/// System32: checking only there refused to start every master on a machine nobody had installed
/// the redistributable on, which the CI runners and every developer machine have (found by the
/// vmtest `master-win11` lane, 2026-10-28).
#[cfg(any(windows, test))]
fn vc_runtime_in(bin: &Path, system: &Path) -> Check {
    let missing: Vec<&str> = CRT.iter().copied().filter(|dll| !bin.join(dll).exists() && !system.join(dll).exists()).collect();
    if !missing.is_empty() {
        let detail = format!(
            "the VC++ 2015-2022 runtime mongod needs is missing ({}): neither {} nor System32 has it; reinstalling LGR Server puts it back",
            missing.join(", "),
            bin.display()
        );
        return check("vc-runtime", false, detail);
    }
    if CRT.iter().all(|dll| bin.join(dll).exists()) {
        check("vc-runtime", true, format!("the VC++ runtime ships with the server ({})", bin.display()))
    } else {
        check("vc-runtime", true, "the VC++ runtime is installed")
    }
}

/// `bin` holds the `mongod` that will run (`install::runtime_bin`).
#[cfg(windows)]
pub fn vc_runtime(bin: &Path) -> Check {
    let system = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| r"C:\Windows".into()).join("System32");
    vc_runtime_in(bin, &system)
}

/// Every check, in the order they are shown. `bin` holds the `mongod` that will run
/// (`install::runtime_bin`).
pub fn run(data: &Path, #[allow(unused_variables)] bin: &Path) -> Vec<Check> {
    #[allow(unused_mut)]
    let mut checks = machine(data);
    #[cfg(windows)]
    checks.push(vc_runtime(bin));
    checks
}

/// Whether a failed check stops the supervisor from starting: only what makes running impossible
/// (`mongod` dies of SIGILL without AVX, or cannot load its runtime) or unsafe (a database on a share
/// or on tmpfs). Memory and disk are the installers' floor: a master already running on the machine
/// starts below it, and says so.
pub fn blocks_start(c: &Check) -> bool {
    !c.ok && matches!(c.name, "cpu" | "location" | "vc-runtime")
}

/// What an installer checks, before anything of the package exists: the machine itself. Not the VC++
/// runtime, which the package carries.
pub fn machine(data: &Path) -> Vec<Check> {
    vec![cpu(), memory(), disk(data), location(data)]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory on the disk the build is on. Not the system temp: on a Linux CI runner
    /// that is tmpfs, which the location check rightly refuses (it is gone after a restart).
    fn scratch() -> tempfile::TempDir {
        let beside = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        tempfile::Builder::new().prefix("preflight-").tempdir_in(beside).unwrap()
    }

    #[test]
    fn this_machine_answers_every_check() {
        let dir = scratch();
        let checks = run(dir.path(), dir.path());
        let names: Vec<&str> = checks.iter().map(|c| c.name).collect();
        assert!(names.starts_with(&["cpu", "memory", "disk", "location"]), "{names:?}");
        // A developer machine or a CI runner can run MongoDB (the test suite does): these hold here.
        for c in &checks {
            if ["cpu", "location"].contains(&c.name) {
                assert!(c.ok, "{c:?}");
            }
            assert!(!c.detail.is_empty());
        }
        assert!(total_ram().unwrap() > 0);
        assert!(free_disk(dir.path()).unwrap() > 0);
    }

    #[test]
    fn a_data_directory_that_does_not_exist_yet_is_measured_where_it_will_be() {
        let dir = scratch();
        let future = dir.path().join("not").join("yet");
        assert!(free_disk(&future).is_some());
        assert!(location(&future).ok);
    }

    /// Found by CI: the runner's `/tmp` is tmpfs. A data directory there is gone after a restart.
    /// `/dev/shm` is tmpfs on any Linux.
    #[cfg(target_os = "linux")]
    #[test]
    fn tmpfs_is_refused() {
        let c = location(Path::new("/dev/shm/lgr"));
        assert!(!c.ok, "{c:?}");
        assert!(c.detail.contains("tmpfs"), "{c:?}");
    }

    #[test]
    fn a_network_path_is_refused() {
        assert!(not_local(Path::new(r"\\fileserver\share\lgr")).is_some());
        assert!(not_local(Path::new("//fileserver/share/lgr")).is_some());
    }

    /// A machine with 4 GB installed reads under 4 GiB (a 4096 MB VM: 3.8 GB) and must pass; a 3 GB
    /// one must not.
    #[test]
    fn a_4_gb_machine_has_enough_memory_and_a_3_gb_one_does_not() {
        let gib = |g: f64| (g * (1u64 << 30) as f64) as u64;
        assert!(memory_of(gib(3.8)).ok);
        assert!(memory_of(gib(3.3)).ok, "a 4 GB machine whose integrated GPU keeps 512 MB");
        let small = memory_of(gib(2.9));
        assert!(!small.ok);
        assert_eq!(small.detail, "2.9 GB of RAM usable (a machine with 4.0 GB is the least)");
    }

    /// FR-20.12: a container (or a unit with `MemoryMax=`) gets its limit, not the machine.
    #[test]
    fn a_memory_limit_is_what_this_server_gets() {
        const GB: u64 = 1 << 30;
        let tree = |files: &[(&str, &str)]| {
            let dir = scratch();
            for (rel, text) in files {
                let p = dir.path().join(rel);
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(p, text).unwrap();
            }
            dir
        };
        // A container with --memory 2g: cgroup v2, its own namespace, so its cgroup is the top it sees.
        let c = tree(&[("memory.max", "2147483648\n")]);
        assert_eq!(cgroup_limit("0::/\n", c.path()), Some(2 * GB));
        // A service on a machine: no limit anywhere up the tree, and the root has no memory.max.
        let s = tree(&[("system.slice/memory.max", "max\n"), ("system.slice/lgr-server.service/memory.max", "max\n")]);
        assert_eq!(cgroup_limit("0::/system.slice/lgr-server.service\n", s.path()), None);
        // A parent's limit binds: the least on the way up.
        let n = tree(&[("system.slice/memory.max", "3221225472\n"), ("system.slice/lgr-server.service/memory.max", "6442450944\n")]);
        assert_eq!(cgroup_limit("0::/system.slice/lgr-server.service\n", n.path()), Some(3 * GB));
        // cgroup v1: the memory controller's line, its "unlimited" sentinel, other controllers ignored.
        let v1 = tree(&[("memory/memory.limit_in_bytes", "4294967296\n")]);
        assert_eq!(cgroup_limit("12:cpu,cpuacct:/docker/abc\n4:memory:/docker/abc\n", v1.path()), Some(4 * GB));
        let unlimited = tree(&[("memory/memory.limit_in_bytes", "9223372036854771712\n")]);
        assert_eq!(cgroup_limit("4:memory:/\n", unlimited.path()), None);
        assert_eq!(cgroup_limit("", c.path()), None);
        assert_eq!(cgroup_limit("not a cgroup line\n", c.path()), None);

        let small = memory_under_limit(2 * GB, 16 * GB);
        assert!(!small.ok, "{small:?}");
        assert!(small.detail.starts_with("2.0 GB of RAM usable: this server's memory limit"), "{small:?}");
        assert!(small.detail.contains("on a machine with 16.0 GB"), "{small:?}");
        assert!(memory_under_limit(4 * GB, 16 * GB).ok);
    }

    /// The supervisor refuses to start only where running is impossible or unsafe. A master that has
    /// run for months is not stopped at a reboot for its free disk or its RAM.
    #[test]
    fn only_cpu_location_and_runtime_stop_a_start() {
        for (name, blocks) in [("cpu", true), ("location", true), ("vc-runtime", true), ("memory", false), ("disk", false)] {
            assert_eq!(blocks_start(&check(name, false, "x")), blocks, "{name}");
            assert!(!blocks_start(&check(name, true, "x")), "a passing {name} blocks nothing");
        }
    }

    /// The .deb's preinst refuses what the installers' floor refuses: the same numbers, the same file
    /// systems, the same CPU features, on a first install only.
    #[test]
    fn the_preinst_mirrors_the_checks() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("packaging").join("linux").join("preinst");
        let preinst = std::fs::read_to_string(&path).unwrap();
        let line = |want: String| assert!(preinst.lines().any(|l| l.trim() == want), "{} has no line `{want}`", path.display());
        line(format!("MIN_RAM_KIB={}", MIN_USABLE_RAM >> 10));
        line(format!("MIN_FREE_KIB={}", MIN_FREE_DISK >> 10));
        line("[ \"$1\" = install ] || exit 0".into());
        for needle in [
            "grep -qw avx /proc/cpuinfo",
            "grep -qw dcpop /proc/cpuinfo",
            "6969)",
            "517b | ff534d42 | fe534d42)",
            "65735546)",
            "1021994)",
            "794c7630)",
            "cannot run on this machine, so nothing was installed",
            "(a machine with 4.0 GB is the least)",
        ] {
            assert!(preinst.contains(needle), "{} lost `{needle}`", path.display());
        }
    }

    /// FR-20.12: an image is built on a machine that is not the one it runs on, so its build skips the
    /// preinst's check (the container's own start checks where it runs), and nothing else does.
    #[test]
    fn only_the_image_build_skips_the_preinsts_check() {
        let packaging = Path::new(env!("CARGO_MANIFEST_DIR")).join("packaging");
        let preinst = std::fs::read_to_string(packaging.join("linux").join("preinst")).unwrap();
        let skip = preinst.lines().position(|l| l.contains("LGR_SERVER_IMAGE_BUILD")).expect("the preinst names the image build");
        let first_check = preinst.lines().position(|l| l.contains("grep -qw avx")).unwrap();
        assert!(skip < first_check, "the image build is let through before any check");
        // Set for the one command that installs the .deb, and never for the container (an ENV or ARG).
        let dockerfile = std::fs::read_to_string(packaging.join("docker").join("Dockerfile")).unwrap();
        let uses: Vec<&str> = dockerfile.lines().map(str::trim).filter(|l| !l.starts_with('#') && l.contains("LGR_SERVER_IMAGE_BUILD")).collect();
        assert_eq!(uses.len(), 1, "{uses:?}");
        assert!(uses[0].starts_with("LGR_SERVER_IMAGE_BUILD=1 apt-get install"), "{uses:?}");
    }

    fn with_dlls(dir: &Path, dlls: &[&str]) {
        std::fs::create_dir_all(dir).unwrap();
        for d in dlls {
            std::fs::write(dir.join(d), b"").unwrap();
        }
    }

    /// The machine the vmtest lane found: a clean Windows, nothing in System32, the package's own copy
    /// beside mongod.
    #[test]
    fn the_runtime_the_package_carries_is_enough() {
        let dir = scratch();
        let (bin, system) = (dir.path().join("bin"), dir.path().join("System32"));
        with_dlls(&bin, &CRT);
        with_dlls(&system, &[]);
        let c = vc_runtime_in(&bin, &system);
        assert!(c.ok, "{c:?}");
        assert!(c.detail.contains("ships with the server"), "{c:?}");
    }

    #[test]
    fn a_runtime_in_neither_place_is_missing_and_named() {
        let dir = scratch();
        let (bin, system) = (dir.path().join("bin"), dir.path().join("System32"));
        with_dlls(&bin, &["msvcp140.dll"]);
        with_dlls(&system, &[]);
        let c = vc_runtime_in(&bin, &system);
        assert!(!c.ok, "{c:?}");
        assert!(c.detail.contains("vcruntime140.dll, vcruntime140_1.dll"), "{c:?}");
        assert!(!c.detail.contains("msvcp140.dll"), "only what is missing is named: {c:?}");
    }

    /// Windows looks beside the program first and then in System32, one DLL at a time.
    #[test]
    fn system32_still_counts_dll_by_dll() {
        let dir = scratch();
        let (bin, system) = (dir.path().join("bin"), dir.path().join("System32"));
        with_dlls(&bin, &["msvcp140.dll", "vcruntime140.dll"]);
        with_dlls(&system, &["vcruntime140_1.dll"]);
        let c = vc_runtime_in(&bin, &system);
        assert!(c.ok, "{c:?}");
        assert_eq!(c.detail, "the VC++ runtime is installed");
    }
}
