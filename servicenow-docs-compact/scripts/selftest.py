#!/usr/bin/env python3
"""
selftest.py - Regression tests for this skill's scripts and manifest data.

Run after any change to search_pages.py, sync_release.py, or the manifests,
and before packaging for upload:

    python3 scripts/selftest.py            # data + search checks (fast, no network)
    python3 scripts/selftest.py --full     # also exercises sync against a synthetic repo

Every check here exists because the corresponding bug actually shipped once.
Adding a check is cheaper than rediscovering the bug in front of a customer.
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest_io as mio

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
MANIFESTS = SKILL_DIR / "manifests"

PASS, FAIL = [], []


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(name)
    print(f"  {'ok  ' if condition else 'FAIL'} {name}{('  -> ' + detail) if detail and not condition else ''}")
    return condition


def load(path, default=None):
    p = Path(path)
    return json.loads(p.read_text()) if p.exists() else default


def run_search(*args):
    result = subprocess.run([sys.executable, str(SCRIPT_DIR / "search_pages.py"), *args],
                            capture_output=True, text=True)
    return result


def test_data_integrity():
    print("\nManifest data integrity")
    releases = [r["release"] for r in load(MANIFESTS / "_supported_releases.json", {}).get("supported_releases", [])]
    check("supported releases present", bool(releases), "check _supported_releases.json")

    fmt = mio.active_format(SKILL_DIR)
    print(f"  info manifest format on disk: {fmt}")
    check("a manifest layout is present", fmt != "missing")
    base = mio.load_all(SKILL_DIR, "base")
    check("base manifest loads and is non-empty", bool(base))

    # The null-field bug: empty YAML keys parsed to None and crashed search.
    nulls = []
    for pub, pages in base.items():
        for path, entry in pages.items():
            for field in ("title", "description", "topic_type"):
                if not isinstance(entry.get(field), str):
                    nulls.append(f"base/{pub}/{path}:{field}")
    for release in releases:
        for pub, pages in mio.load_all(SKILL_DIR, "overrides", release).items():
            for path, entry in pages.items():
                for field in ("title", "description", "topic_type"):
                    if not isinstance(entry.get(field), str):
                        nulls.append(f"{release}/{pub}/{path}:{field}")
    check("no null/non-string title|description|topic_type", not nulls,
          f"{len(nulls)} bad fields, first: {nulls[:2]}")

    check("every base entry has a releases list",
          all("releases" in e for pages in base.values() for e in pages.values()))

    # Catalog counts must match what search would actually return.
    for release in releases:
        catalog = load(MANIFESTS / "catalog" / f"{release}.json", {})
        overrides = mio.load_all(SKILL_DIR, "overrides", release)
        mismatched = []
        for pub, entry in catalog.items():
            actual = {p for p, e in base.get(pub, {}).items() if release in e.get("releases", [])}
            actual |= set(overrides.get(pub, {}))
            if len(actual) != entry.get("page_count"):
                mismatched.append((pub, entry.get("page_count"), len(actual)))
        check(f"[{release}] catalog page_count matches manifest", not mismatched, str(mismatched[:3]))

        orphans = sorted(set(catalog) - ({p for p, pages in base.items()
                                          if any(release in e.get("releases", []) for e in pages.values())}
                                         | {p for p, pages in overrides.items() if pages}))
        check(f"[{release}] no catalog entries without data", not orphans, str(orphans[:3]))


def test_search():
    print("\nsearch_pages.py behaviour")
    # Publications that carried the null-field crash. These must return results.
    for release, pub, kw in [("zurich", "servicenow-platform", "widget"),
                             ("zurich", "it-service-management", "incident"),
                             ("australia", "employee-service-management", "taxonomy"),
                             ("zurich", "integrate-applications", "outbound"),
                             ("yokohama", "order-management", "pricing")]:
        r = run_search(release, pub, kw, "--limit", "3")
        ok = r.returncode == 0 and json.loads(r.stdout or "{}").get("match_count", 0) > 0
        check(f"search {release}/{pub} '{kw}' returns results", ok,
              (r.stderr.strip().splitlines() or [""])[-1])

    r = run_search("zurich", "order-management", "MACD", "--limit", "3")
    check("acronym expansion fires", "expansions_applied" in json.loads(r.stdout or "{}"))

    r = run_search("zurich", "delta-yokohama-zurich", "order management", "--limit", "3")
    check("cross-release delta publication is searchable",
          json.loads(r.stdout or "{}").get("match_count", 0) > 0)

    r = run_search("notarelease", "order-management", "pricing")
    check("unknown release is named as the problem", "Unknown release" in r.stdout)

    r = run_search("zurich", "order-mgmt", "pricing")
    check("unknown publication suggests alternatives", "did_you_mean" in r.stdout)

    r = run_search("zurich", "order-management", "pricing", "--limit", "0")
    check("--limit below 1 is rejected", "error" in r.stdout)

    r = run_search("zurich", "order-management", "  ")
    check("whitespace-only keywords are rejected", "error" in r.stdout)

    r = run_search("zurich", "build-workflows", "flow", "--limit", "5")
    body = json.loads(r.stdout or "{}")
    check("limit is honoured", len(body.get("results", [])) <= 5)
    check("no markdown escapes leak into titles",
          all("\\(" not in x["title"] for x in body.get("results", [])))


def build_fake_repo(root):
    def page(path, title, description, topic="task"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"---\ntitle: {title}\ndescription: {description}\ntopic_type: {topic}\n---\n\nbody\n")

    def git(*args):
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)

    root.mkdir(parents=True, exist_ok=True)
    git("init", "-q", "-b", "australia", ".")
    git("config", "user.email", "selftest@local")
    git("config", "user.name", "selftest")
    page(root / "markdown/order-management/index.md", "Order Management", "idx", "concept")
    page(root / "markdown/order-management/alpha.md", "Configure volume pricing", "Volume pricing tiers.")
    page(root / "markdown/build-workflows/index.md", "Build Workflows", "idx", "concept")
    page(root / "markdown/build-workflows/flow.md", "Create a flow", "Make a flow.")
    # Empty YAML values: the exact shape that produced JSON nulls upstream.
    (root / "markdown/order-management/nulls.md").write_text("---\ntitle:\ndescription:\ntopic_type: task\n---\n")
    git("add", "-A")
    git("commit", "-qm", "init")
    return root


def test_sync():
    print("\nsync_release.py behaviour (synthetic repo)")
    tmp = Path(tempfile.mkdtemp(prefix="sn-selftest-"))
    try:
        repo = build_fake_repo(tmp / "repo")
        work = tmp / "skill"
        (work / "scripts").mkdir(parents=True)
        (work / "manifests").mkdir(parents=True)
        for name in ("sync_release.py", "search_pages.py", "manifest_io.py"):
            shutil.copy(SCRIPT_DIR / name, work / "scripts" / name)
        for name in ("_synonyms.json", "_supported_releases.json"):
            shutil.copy(MANIFESTS / name, work / "manifests" / name)

        def sync(*args):
            return subprocess.run([sys.executable, str(work / "scripts" / "sync_release.py"),
                                   *args, "--repo-url", str(repo)],
                                  cwd=work, capture_output=True, text=True)

        r = sync("australia")
        check("initial sync succeeds", r.returncode == 0, r.stderr[-300:])

        # On a first sync every page lands in the release override, not base,
        # so look in both rather than assuming a tier.
        null_path = "markdown/order-management/nulls.md"
        entry = (mio.load_all(work, "overrides", "australia").get("order-management", {}).get(null_path)
                 or mio.load_all(work, "base").get("order-management", {}).get(null_path))
        check("empty frontmatter values stored as strings, not null",
              entry is not None and all(isinstance(entry.get(f), str)
                                        for f in ("title", "description", "topic_type")),
              json.dumps(entry))

        # Curated description must survive a routine sync that changes page_count.
        cat_path = work / "manifests/catalog/australia.json"
        catalog = load(cat_path, {})
        catalog["order-management"]["description"] = "CURATED"
        catalog["order-management"]["needs_description"] = False
        cat_path.write_text(json.dumps(catalog))
        (repo / "markdown/order-management/beta.md").write_text(
            "---\ntitle: New page\ndescription: Brand new.\ntopic_type: task\n---\n")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-qm", "add"], cwd=repo, check=True, capture_output=True)
        sync("australia")
        after = load(cat_path, {})["order-management"]
        check("incremental sync preserves curated description",
              after["description"] == "CURATED" and after["needs_description"] is False, json.dumps(after))

        # And must survive a full reconcile, which wipes the catalog directory.
        sync("--full-reconcile", "australia")
        after = load(cat_path, {})["order-management"]
        check("full reconcile preserves curated description",
              after["description"] == "CURATED" and after["needs_description"] is False, json.dumps(after))

        # A publication deleted upstream must disappear from every tier.
        shutil.rmtree(repo / "markdown/build-workflows")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-qm", "rm pub"], cwd=repo, check=True, capture_output=True)
        sync("australia")
        base = mio.load_all(work, "base")
        catalog = load(cat_path, {})
        overrides = mio.load_all(work, "overrides", "australia")
        stale = [p for p, e in base.get("build-workflows", {}).items() if "australia" in e.get("releases", [])]
        check("deleted publication purged from base", not stale, str(stale))
        check("deleted publication purged from catalog", "build-workflows" not in catalog)
        check("deleted publication purged from overrides", not overrides.get("build-workflows"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_encoded_format():
    """Encoded-layout specific checks. Skipped automatically on plain JSON."""
    print("\nEncoded manifest format")
    if mio.active_format(SKILL_DIR) != mio.FORMAT:
        print("  skip (plain JSON layout in use)")
        return

    doc = json.loads((MANIFESTS / "base.enc.json").read_text())
    check("format header present", doc.get("format") == mio.FORMAT and doc.get("version") == mio.VERSION)
    check("payload is pure ASCII (no binary in the package)",
          all(blob.isascii() for blob in doc["publications"].values()))

    # Decoding one publication must not require touching the others.
    pub = "order-management"
    one = mio.load_publication(SKILL_DIR, "base", pub)
    check(f"single-publication decode works ({pub})", len(one) > 0, f"{len(one)} entries")
    check("single decode matches full decode",
          one == mio.load_all(SKILL_DIR, "base").get(pub))

    # No stale plain files left alongside, which would silently double the
    # manifest bytes counted against the 30MB cap.
    leftovers = [str(p) for p in [MANIFESTS / "base.json"] +
                 [MANIFESTS / "overrides" / f"{r}.json" for r in ("australia", "zurich", "yokohama")]
                 if p.exists()]
    check("no leftover plain manifests inflating the package", not leftovers, str(leftovers))


def test_package_limits():
    print("\nPackaging limits")
    total, count = 0, 0
    for p in SKILL_DIR.rglob("*"):
        if p.is_file() and ".checkouts" not in p.parts:
            total += p.stat().st_size
            count += 1
    print(f"  info {total/1e6:.1f} MB across {count} files")
    check("under the 30MB Skills API size cap", total <= 30_000_000, f"{total/1e6:.1f} MB")
    check("under the 200-file Skills API cap", count <= 200, f"{count} files")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="also run sync tests (slower, uses a temp git repo)")
    args = parser.parse_args()

    test_data_integrity()
    test_search()
    test_encoded_format()
    if args.full:
        test_sync()
    test_package_limits()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        for name in FAIL:
            print(f"  failed: {name}")
        sys.exit(1)


if __name__ == "__main__":
    main()
