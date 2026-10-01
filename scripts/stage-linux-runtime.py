#!/usr/bin/env python3
"""Assemble a transferable BetterJITLinux root directory.

The historical browser Linux harness uses several host mounts. This tool merges
those mounts into the single directory consumed by DirectoryLinuxFileSystem and
records symlinks/modes in JSON so Files/Finder transfers do not have to preserve
Unix metadata.
"""
from __future__ import annotations
import argparse, json, os, pathlib, shutil, stat, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[1]

def guest_join(prefix: str, relative: pathlib.PurePath) -> str:
    suffix = "/".join(relative.parts)
    if prefix == "/":
        return "/" + suffix if suffix else "/"
    return prefix.rstrip("/") + ("/" + suffix if suffix else "")

def remove_existing(path: pathlib.Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)

def stage_mount(src: pathlib.Path, dst_root: pathlib.Path, guest_prefix: str,
                links: dict[str, str], modes: dict[str, int]) -> int:
    if not src.exists():
        return 0
    src = src.resolve()
    copied = 0
    for base, dirs, files in os.walk(src, topdown=True, followlinks=False):
        base_path = pathlib.Path(base)
        rel_base = base_path.relative_to(src)
        guest_base = guest_join(guest_prefix, rel_base)
        dst_base = dst_root / guest_base.lstrip("/")
        dst_base.mkdir(parents=True, exist_ok=True)
        modes[guest_base] = stat.S_IMODE(os.lstat(base).st_mode)

        kept_dirs = []
        for name in dirs:
            source = base_path / name
            rel = source.relative_to(src)
            guest = guest_join(guest_prefix, rel)
            target = dst_root / guest.lstrip("/")
            st = os.lstat(source)
            if stat.S_ISLNK(st.st_mode):
                raw = os.readlink(source)
                if os.path.isabs(raw):
                    try:
                        inside = pathlib.Path(raw).resolve().relative_to(src)
                        raw = guest_join(guest_prefix, inside)
                    except (ValueError, OSError):
                        pass
                links[guest] = raw
                if target.exists() or target.is_symlink():
                    remove_existing(target)
                copied += 1
            else:
                target.mkdir(parents=True, exist_ok=True)
                modes[guest] = stat.S_IMODE(st.st_mode)
                kept_dirs.append(name)
        dirs[:] = kept_dirs

        for name in files:
            source = base_path / name
            rel = source.relative_to(src)
            guest = guest_join(guest_prefix, rel)
            target = dst_root / guest.lstrip("/")
            st = os.lstat(source)
            if stat.S_ISLNK(st.st_mode):
                raw = os.readlink(source)
                if os.path.isabs(raw):
                    try:
                        inside = pathlib.Path(raw).resolve().relative_to(src)
                        raw = guest_join(guest_prefix, inside)
                    except (ValueError, OSError):
                        pass
                links[guest] = raw
                if target.exists() or target.is_symlink():
                    remove_existing(target)
            elif stat.S_ISREG(st.st_mode):
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() or target.is_symlink():
                    remove_existing(target)
                shutil.copyfile(source, target)
                try:
                    os.chmod(target, stat.S_IMODE(st.st_mode))
                except OSError:
                    pass
                modes[guest] = stat.S_IMODE(st.st_mode)
            copied += 1
    return copied

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=pathlib.Path, default=ROOT/"build/linuxroot/root")
    p.add_argument("--sysroot", type=pathlib.Path, default=ROOT/"build/sysroot-x86_64")
    p.add_argument("--wine", type=pathlib.Path, default=ROOT/"build/wine-install/opt/wine")
    p.add_argument("--test", type=pathlib.Path, default=ROOT/"build/test")
    p.add_argument("--output", type=pathlib.Path, default=ROOT/".build/device-linuxroot")
    p.add_argument("--strict", action="store_true", help="fail if root/sysroot/wine inputs are absent")
    p.add_argument("--clean", action="store_true", help="replace the output directory first")
    a = p.parse_args()

    required = [("root", a.root), ("sysroot", a.sysroot), ("wine", a.wine)]
    missing = [(name, path) for name, path in required if not path.exists()]
    if a.strict and missing:
        for name, path in missing:
            print(f"missing {name}: {path}", file=sys.stderr)
        return 2

    out = a.output.resolve()
    if a.clean and out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)
    links: dict[str, str] = {}
    modes: dict[str, int] = {"/": 0o755}
    count = 0

    count += stage_mount(a.root, out, "/", links, modes)
    if (a.sysroot/"lib").exists():
        count += stage_mount(a.sysroot/"lib", out, "/lib", links, modes)
    count += stage_mount(a.wine, out, "/opt/wine", links, modes)
    count += stage_mount(a.test, out, "/test", links, modes)

    for path in ["/proc","/dev","/sys","/tmp","/usr","/usr/bin","/bin","/home","/home/user","/opt"]:
        d = out/path.lstrip("/")
        d.mkdir(parents=True, exist_ok=True)
        modes.setdefault(path, 0o755)

    (out/".symlinks.json").write_text(json.dumps(dict(sorted(links.items())), indent=2) + "\n")
    (out/".modes.json").write_text(json.dumps(dict(sorted(modes.items())), indent=2) + "\n")
    meta = {
        "schema": 1,
        "generatedAtUnix": int(time.time()),
        "inputs": {
            "root": str(a.root.resolve()) if a.root.exists() else None,
            "sysroot": str(a.sysroot.resolve()) if a.sysroot.exists() else None,
            "wine": str(a.wine.resolve()) if a.wine.exists() else None,
            "test": str(a.test.resolve()) if a.test.exists() else None,
        },
        "filesAndLinksVisited": count,
        "symlinksRecorded": len(links),
        "modeOverrides": len(modes),
        "winePresent": (out/"opt/wine/bin/wine").is_file(),
    }
    (out/".betterjit-linux-root.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(out)
    print(f"{count} entries staged; {len(links)} symlinks; wine={'yes' if meta['winePresent'] else 'no'}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
