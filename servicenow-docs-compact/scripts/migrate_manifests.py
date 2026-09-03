#!/usr/bin/env python3
"""
migrate_manifests.py - Convert manifest data between the plain and encoded
layouts, in either direction.

    python3 scripts/migrate_manifests.py --encode    plain .json  -> .enc.json
    python3 scripts/migrate_manifests.py --decode    .enc.json    -> plain .json
    python3 scripts/migrate_manifests.py --status    report what's on disk

Both directions are lossless and verified before anything is deleted: every
publication is decoded back and compared against the source, and the conversion
aborts if any publication fails to round-trip. Source files are only removed
when --prune is passed, and never before verification passes.

Keeping both directions working is deliberate. If the encoded layout ever
causes trouble at upload time, --decode restores exactly the layout that is
known to upload cleanly today.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest_io as mio

SKILL_DIR = Path(__file__).resolve().parent.parent


def tiers(skill_dir):
    releases = [r["release"] for r in
                json.loads((mio.manifests_root(skill_dir) / "_supported_releases.json").read_text())
                .get("supported_releases", [])]
    yield ("base", None)
    for release in releases:
        yield ("overrides", release)


def human(path):
    return f"{path.stat().st_size/1e6:.2f} MB" if path.exists() else "absent"


def status(skill_dir):
    print(f"Active format: {mio.active_format(skill_dir)}\n")
    total_enc = total_plain = 0
    for tier, release in tiers(skill_dir):
        enc, plain = mio.tier_paths(skill_dir, tier, release)
        label = tier if release is None else f"{tier}/{release}"
        print(f"  {label:22s} plain {human(Path(plain)):>10s}   encoded {human(Path(enc)):>10s}")
        total_enc += Path(enc).stat().st_size if Path(enc).exists() else 0
        total_plain += Path(plain).stat().st_size if Path(plain).exists() else 0
    print(f"\n  {'totals':22s} plain {total_plain/1e6:7.2f} MB   encoded {total_enc/1e6:7.2f} MB")


def convert(skill_dir, direction, prune):
    converted = []
    for tier, release in tiers(skill_dir):
        enc, plain = (Path(p) for p in mio.tier_paths(skill_dir, tier, release))
        source, target = (plain, enc) if direction == "encode" else (enc, plain)
        label = tier if release is None else f"{tier}/{release}"

        if not source.exists():
            print(f"  {label:22s} source missing, skipped")
            continue

        data = mio.load_all(skill_dir, tier, release) if direction == "decode" else json.loads(source.read_text())

        if direction == "encode":
            mio.save_all(skill_dir, tier, data, release)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(data, separators=(",", ":"), sort_keys=True))

        # Verify before anything is deleted: read the target back through the
        # same code path the scripts use and compare publication by publication.
        readback = {}
        if direction == "encode":
            doc = json.loads(target.read_text())
            readback = {pub: mio.decode_publication(blob) for pub, blob in doc["publications"].items()}
            expected = {pub: pages for pub, pages in data.items() if pages}
        else:
            readback = json.loads(target.read_text())
            expected = {pub: pages for pub, pages in data.items() if pages}

        if readback != expected:
            missing = sorted(set(expected) - set(readback))
            differing = sorted(p for p in set(expected) & set(readback) if expected[p] != readback[p])
            print(f"  {label:22s} FAILED round-trip. missing={missing[:3]} differing={differing[:3]}")
            sys.exit(1)

        pages = sum(len(v) for v in expected.values())
        print(f"  {label:22s} {source.stat().st_size/1e6:6.2f} -> {target.stat().st_size/1e6:5.2f} MB   "
              f"{len(expected)} publications, {pages:,} pages, verified")
        converted.append((source, target))

    if prune:
        for source, _ in converted:
            source.unlink()
        print(f"\nRemoved {len(converted)} source file(s).")
    else:
        print("\nSource files kept. Re-run with --prune to remove them once you're satisfied.")
        print("Note: leaving both layouts in place doubles the manifest bytes in the package.")


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--encode", action="store_true", help="plain .json -> .enc.json")
    group.add_argument("--decode", action="store_true", help=".enc.json -> plain .json")
    group.add_argument("--status", action="store_true", help="report what is on disk")
    parser.add_argument("--prune", action="store_true", help="delete source files after verification passes")
    args = parser.parse_args()

    if args.status:
        status(SKILL_DIR)
        return
    convert(SKILL_DIR, "encode" if args.encode else "decode", args.prune)


if __name__ == "__main__":
    main()
