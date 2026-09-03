#!/usr/bin/env python3
"""
sync_release.py, Maintains the ServiceNow docs manifest using a base+override
architecture designed to fit within the Skills API's 30MB package cap while
still covering every publication across every tracked release.

WHY THIS SHAPE (see references/architecture.md for the full derivation):
  - A naive flat manifest (all pages, all fields, one release) already runs
    ~35-38MB, over the cap for ONE release, let alone three.
  - Fields dropped entirely because they added size without adding retrieval
    value at this scale: canonical_url, last_updated, product. Kept: title,
    description, topic_type.
  - breadcrumb is ALSO dropped, not because it's useless, but because
    navigation reorganizes far more often than content changes, so keeping it
    made almost every page look "different across releases" and defeated
    deduplication. Without it, ~88% of pages are byte-identical wherever they
    appear, so the base+override split gets real, measured savings.
  - Result: base (~19MB) + 3 release overrides (~2MB each) = ~24.8MB measured
    against the real repo. Leaves ~5MB headroom under the 30MB cap for
    SKILL.md, this script, and catalog files. That headroom is NOT large -
    adding a 4th tracked release or substantial upstream growth could tip this
    over again. If `python3 sync_release.py --check-size` reports getting
    close to 30MB, that's the signal to revisit this design, not ignore it.
  - SEPARATELY, the Skills API also caps a package at 200 FILES TOTAL,
    regardless of byte size. The original per-publication layout (one file per
    publication per tier: base/<pub>.json, overrides/<release>/<pub>.json)
    passed the size check comfortably but produced 263 files, 63
    publications x 4 tiers, and failed upload on file count alone. Fixed by
    consolidating each tier into ONE file (manifests/base.json,
    manifests/overrides/<release>.json) instead of one-file-per-publication.
    Same bytes, same dedup logic, just packaged into fewer files (19 total).
    Don't reintroduce per-publication files without re-checking BOTH caps -
    they're independent constraints and either one alone can block upload.

TWO MODES:
  1. Incremental (normal day-to-day use):
       python3 sync_release.py <release>
     Pulls just that one release's branch, reprocesses only publications with
     upstream changes, and reconciles each changed page against the EXISTING
     base file (no need to check out other releases). This is what the
     scheduled refresh task should run per release.
     Tradeoff: a brand-new page that happens to be identical to another
     release's version won't be auto-detected as shared until the next full
     reconcile, it'll just live in this release's override until then. Safe
     (nothing is lost or wrong), just not maximally deduplicated in between.

  2. Full reconcile (occasional maintenance, e.g. monthly, or whenever size
     creeps up):
       python3 sync_release.py --full-reconcile australia zurich yokohama
     Clones/pulls ALL listed releases and rebuilds base+overrides from
     scratch, like this script's first-ever run. Re-optimizes deduplication
     across releases. Costs more (needs every release checked out at once)
     but is the thing that keeps this design's size advantage from eroding
     over time.

Directory layout produced (all under the skill's manifests/ folder):
    manifests/base.json                              ALL publications, one file:
        {"<publication>": {"<path>": {"title":..,"description":..,"topic_type":..,"releases":[...]}}}
    manifests/overrides/<release>.json                ALL publications for that release, one file:
        {"<publication>": {"<path>": {"title":..,"description":..,"topic_type":..}}}
    manifests/catalog/<release>.json                one entry per publication
    manifests/_state/<release>.json                 last_indexed_commit etc.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest_io as mio

DEFAULT_REPO_URL = "https://github.com/ServiceNow/ServiceNowDocs.git"
SKILL_SIZE_WARN_BYTES = 25_000_000   # start warning well before the 30MB cap
SKILL_SIZE_CAP_BYTES = 30_000_000
SKILL_FILE_COUNT_WARN = 150          # start warning well before the 200-file cap
SKILL_FILE_COUNT_CAP = 200


def run(cmd, cwd=None, check=True):
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\nstdout: {result.stdout}\nstderr: {result.stderr}")
    return result


def clone_or_update(repo_url, branch, checkout_dir):
    checkout_dir = Path(checkout_dir)
    if checkout_dir.exists() and (checkout_dir / ".git").exists():
        try:
            run(["git", "fetch", "--depth", "1", "origin", branch], cwd=checkout_dir)
            run(["git", "reset", "--hard", f"origin/{branch}"], cwd=checkout_dir)
        except RuntimeError as e:
            raise RuntimeError(
                f"Could not fetch branch '{branch}' (it may have been deleted upstream, "
                f"ServiceNow retains only the 3 most recent release branches plus 'latest'). {e}"
            )
    else:
        checkout_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            run(["git", "clone", "--depth", "1", "--branch", branch, repo_url, str(checkout_dir)])
        except RuntimeError as e:
            raise RuntimeError(
                f"Could not clone branch '{branch}' (it may not exist upstream anymore, or "
                f"was renamed, see ServiceNow's branch retention policy). {e}"
            )
    return run(["git", "rev-parse", "HEAD"], cwd=checkout_dir).stdout.strip()


def parse_frontmatter(text):
    import yaml
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    try:
        return yaml.safe_load(parts[1]) or {}
    except Exception:
        return {}


def list_publications(repo_dir):
    md_dir = Path(repo_dir) / "markdown"
    return sorted(p.name for p in md_dir.iterdir() if p.is_dir())


def changed_publications(repo_dir, old_commit, new_commit):
    """None means 'treat everything as changed' (first run or diff unavailable)."""
    if not old_commit:
        return None
    result = run(["git", "diff", "--name-only", f"{old_commit}..{new_commit}"], cwd=repo_dir, check=False)
    if result.returncode != 0:
        return None
    changed = set()
    for line in result.stdout.splitlines():
        parts = line.split("/")
        if len(parts) >= 2 and parts[0] == "markdown":
            changed.add(parts[1])
    return changed


TRIMMED_FIELDS = ("title", "description", "topic_type")  # breadcrumb/canonical_url/last_updated/product dropped, see module docstring


def parse_publication_pages(repo_dir, publication):
    """Mechanical parse only, no LLM calls. Returns {path: {title, description, topic_type}}."""
    pub_dir = Path(repo_dir) / "markdown" / publication
    pages = {}
    for path in sorted(pub_dir.rglob("*.md")):
        if path.name == "index.md":
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        fm = parse_frontmatter(text)
        rel_path = str(path.relative_to(Path(repo_dir)))
        # `or` rather than a dict default: ServiceNow ships pages with an
        # empty `title:` / `description:` key, which PyYAML returns as None,
        # not as a missing key. Storing those as JSON null used to crash
        # search_pages.py outright (AttributeError on None.lower()) for four
        # of the largest publications. Coerce to a string here so nulls never
        # enter the manifest in the first place.
        pages[rel_path] = {
            "title": str(fm.get("title") or path.stem),
            "description": str(fm.get("description") or ""),
            "topic_type": str(fm.get("topic_type") or ""),
        }
    return pages


def publication_title_and_bundle(repo_dir, publication):
    index_path = Path(repo_dir) / "markdown" / publication / "index.md"
    if index_path.exists():
        fm = parse_frontmatter(index_path.read_text(encoding="utf-8", errors="replace"))
        return fm.get("title", publication), fm.get("bundle", "")
    return publication, ""


def draft_catalog_description(pages_dict):
    """Extractive starting point (not a substitute for Claude reviewing it -
    every catalog entry stays flagged needs_description=True)."""
    if not pages_dict:
        return ""
    overview_kw = ("overview", "getting started", "introduction", "landing", "explore")
    described = [p for p in pages_dict.values() if p.get("description")]
    candidates = [p for p in described if any(k in (p.get("title") or "").lower() for k in overview_kw)]
    if not candidates:
        candidates = described
    if not candidates:
        return ""
    return min(candidates, key=lambda p: len(p["description"]))["description"]


def load_json(path, default):
    path = Path(path)
    return json.loads(path.read_text()) if path.exists() else default


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":"), sort_keys=True))


def manifests_root(skill_dir):
    return skill_dir / "manifests"


# --- Consolidated-file helpers -------------------------------------------------
# IMPORTANT: base and overrides are each ONE file (not one file per publication).
# A per-publication layout was the original design and works fine for the 30MB
# size cap, but the Skills API separately caps a package at 200 FILES TOTAL -
# 63 publications x 4 tiers (base + 3 release overrides) blew past that at 263
# files even though the byte size was fine. Consolidating into a handful of
# files fixes file-count without changing any of the size math: same bytes,
# packaged differently. Keep it this way going forward, don't reintroduce
# per-publication files without re-checking the file-count cap.

def load_base(skill_dir):
    return mio.load_all(skill_dir, "base")


def save_base(skill_dir, data):
    mio.save_all(skill_dir, "base", data)


def load_overrides(skill_dir, release):
    return mio.load_all(skill_dir, "overrides", release)


def save_overrides(skill_dir, release, data):
    mio.save_all(skill_dir, "overrides", data, release)


def update_catalog_entry(skill_dir, release, publication, page_count, base_count, override_count, sample_pages_for_desc):
    cat_path = manifests_root(skill_dir) / "catalog" / f"{release}.json"
    catalog = load_json(cat_path, {})
    entry = catalog.get(publication, {})
    entry["page_count"] = page_count
    entry["base_count"] = base_count
    entry["override_count"] = override_count

    # A description is "curated" once someone has rewritten it by hand and
    # cleared needs_description. Never regenerate those. The previous rule
    # regenerated whenever page_count changed, which meant any routine sync
    # that touched the publication silently replaced a hand-written
    # description with the extractive draft and re-raised the flag. Since the
    # scheduled refresh runs several times a week, curated descriptions had a
    # lifespan of days, and SKILL.md asks people to invest in exactly that
    # curation. Only uncurated entries get redrafted.
    curated = entry.get("description") and not entry.get("needs_description", True)
    if not curated:
        entry["description"] = draft_catalog_description(sample_pages_for_desc)
        entry["needs_description"] = True
    catalog[publication] = entry
    save_json(cat_path, catalog)


def load_curated_descriptions(skill_dir, releases):
    """Snapshot hand-written catalog descriptions before a destructive rebuild.
    full_reconcile wipes manifests/catalog/ wholesale, which used to delete
    every curated description along with it."""
    curated = {}
    for release in releases:
        catalog = load_json(manifests_root(skill_dir) / "catalog" / f"{release}.json", {})
        for pub, entry in catalog.items():
            if entry.get("description") and not entry.get("needs_description", True):
                curated.setdefault(release, {})[pub] = entry["description"]
    return curated


def restore_curated_descriptions(skill_dir, curated):
    """Re-apply the snapshot taken by load_curated_descriptions."""
    restored = 0
    for release, pubs in curated.items():
        cat_path = manifests_root(skill_dir) / "catalog" / f"{release}.json"
        catalog = load_json(cat_path, {})
        changed = False
        for pub, description in pubs.items():
            if pub in catalog:
                catalog[pub]["description"] = description
                catalog[pub]["needs_description"] = False
                changed = True
                restored += 1
        if changed:
            save_json(cat_path, catalog)
    return restored


def sync_incremental(release, branch, repo_url, skill_dir):
    branch = branch or release
    work_dir = skill_dir / ".checkouts" / release
    state_path = manifests_root(skill_dir) / "_state" / f"{release}.json"
    state = load_json(state_path, {})
    old_commit = state.get("last_indexed_commit")

    print(f"[{release}] syncing branch '{branch}'...", file=sys.stderr)
    new_commit = clone_or_update(repo_url, branch, work_dir)

    if old_commit == new_commit:
        print(f"[{release}] no upstream changes since last sync ({new_commit[:8]})", file=sys.stderr)
        print(json.dumps({"release": release, "changed": False, "commit": new_commit, "changed_publications": []}))
        return

    changed_pubs = changed_publications(work_dir, old_commit, new_commit)
    all_pubs = list_publications(work_dir)
    to_process = all_pubs if changed_pubs is None else sorted(set(changed_pubs) & set(all_pubs))
    print(f"[{release}] processing {len(to_process)} of {len(all_pubs)} publications", file=sys.stderr)

    base_all = load_base(skill_dir)          # {publication: {path: entry_with_releases}}
    overrides_all = load_overrides(skill_dir, release)  # {publication: {path: entry}}

    # Publications removed upstream. The per-page deletion pass below only runs
    # for publications still present in the checkout, and to_process is
    # intersected with all_pubs, so a publication deleted wholesale used to be
    # skipped entirely: it stayed in base, overrides and the catalog forever,
    # and search kept returning pages that 404 on fetch. Purge them here.
    tracked_pubs = {p for p, pages in base_all.items()
                    if any(release in e.get("releases", []) for e in pages.values())}
    tracked_pubs |= {p for p, pages in overrides_all.items() if pages}
    removed_pubs = sorted(tracked_pubs - set(all_pubs))
    if removed_pubs:
        catalog = load_json(manifests_root(skill_dir) / "catalog" / f"{release}.json", {})
        for pub in removed_pubs:
            overrides_all.pop(pub, None)
            catalog.pop(pub, None)
            pages = base_all.get(pub, {})
            for path in list(pages):
                remaining = set(pages[path].get("releases", [])) - {release}
                if remaining:
                    pages[path]["releases"] = sorted(remaining)
                else:
                    pages.pop(path)
            if not pages:
                base_all.pop(pub, None)
        save_json(manifests_root(skill_dir) / "catalog" / f"{release}.json", catalog)
        print(f"[{release}] removed {len(removed_pubs)} publication(s) deleted upstream: "
              f"{', '.join(removed_pubs)}", file=sys.stderr)

    for pub in to_process:
        new_pages = parse_publication_pages(work_dir, pub)

        base = base_all.get(pub, {})
        override = overrides_all.get(pub, {})

        # reconcile every current page against base
        seen_paths = set()
        for path, entry in new_pages.items():
            seen_paths.add(path)
            base_entry = base.get(path)
            base_content = {k: base_entry[k] for k in TRIMMED_FIELDS} if base_entry else None
            if base_content == entry:
                # matches base -> rely on it, drop any stale override, ensure release is tagged
                override.pop(path, None)
                releases = set(base_entry.get("releases", []))
                releases.add(release)
                base[path] = {**entry, "releases": sorted(releases)}
            else:
                # diverges (or base has no entry yet) -> this release needs its own copy
                override[path] = entry
                if base_entry:
                    releases = set(base_entry.get("releases", [])) - {release}
                    if releases:
                        base[path] = {**base_entry, "releases": sorted(releases)}
                    else:
                        base.pop(path, None)  # no release matches this base entry anymore

        # handle deletions: paths this release used to have (in base-for-this-release
        # or in its override) that no longer exist upstream
        previously_tracked = {p for p, e in base.items() if release in e.get("releases", [])} | set(override.keys())
        for path in previously_tracked - seen_paths:
            override.pop(path, None)
            base_entry = base.get(path)
            if base_entry:
                releases = set(base_entry.get("releases", [])) - {release}
                if releases:
                    base[path] = {**base_entry, "releases": sorted(releases)}
                else:
                    base.pop(path, None)

        base_all[pub] = base
        if override:
            overrides_all[pub] = override
        else:
            overrides_all.pop(pub, None)  # don't persist empty publication keys

        combined = {p: {k: e[k] for k in TRIMMED_FIELDS} for p, e in base.items() if release in e.get("releases", [])}
        combined.update(override)
        if not combined:
            # The publication directory still exists upstream (so it wasn't
            # caught by the removed_pubs pass above) but every real content
            # page under it is gone, e.g. reduced to a bare TOC stub. Purge
            # the catalog entry rather than leaving a page_count:0 stub
            # behind: a dangling empty entry is worse than no entry, since
            # search would offer it as a candidate publication with nothing
            # in it, and a stale curated description would describe content
            # that no longer exists.
            base_all.pop(pub, None)
            overrides_all.pop(pub, None)
            cat_path = manifests_root(skill_dir) / "catalog" / f"{release}.json"
            catalog = load_json(cat_path, {})
            if catalog.pop(pub, None) is not None:
                save_json(cat_path, catalog)
                print(f"[{release}]   {pub}: 0 pages remaining, purged from catalog", file=sys.stderr)
        else:
            update_catalog_entry(skill_dir, release, pub, len(combined), len(combined) - len(override), len(override), combined)
            print(f"[{release}]   {pub}: {len(combined)} pages ({len(override)} override, {len(combined)-len(override)} shared)", file=sys.stderr)

    save_base(skill_dir, base_all)
    save_overrides(skill_dir, release, overrides_all)

    state = {"release": release, "branch": branch, "last_indexed_commit": new_commit,
              "last_synced": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    save_json(state_path, state)
    print(json.dumps({"release": release, "changed": True, "commit": new_commit, "changed_publications": to_process}))


def full_reconcile(releases, repo_url, skill_dir):
    """Rebuild base+overrides from scratch across ALL listed releases. Requires
    checking out every release. Use this for the first-ever build, or
    periodically to re-optimize dedup that incremental syncs can't fully
    achieve on their own (see module docstring)."""
    print(f"Full reconcile across: {', '.join(releases)}", file=sys.stderr)
    commits = {}
    all_pubs = set()
    per_release_pages = {}  # release -> {pub: {path: entry}}
    for release in releases:
        work_dir = skill_dir / ".checkouts" / release
        commits[release] = clone_or_update(repo_url, release, work_dir)
        pubs = list_publications(work_dir)
        all_pubs.update(pubs)
        per_release_pages[release] = {}
        for pub in pubs:
            per_release_pages[release][pub] = parse_publication_pages(work_dir, pub)
        print(f"  [{release}] {commits[release][:8]}, {len(pubs)} publications", file=sys.stderr)

    # Snapshot curated catalog descriptions BEFORE the wipe below. Without
    # this, every monthly full reconcile silently discarded all hand-written
    # publication descriptions and reset them to the extractive draft.
    curated = load_curated_descriptions(skill_dir, releases)

    # wipe and rebuild
    import shutil
    for sub in ("base.json", "base.enc.json"):
        p = manifests_root(skill_dir) / sub
        if p.exists():
            p.unlink()
    for sub in ("overrides", "catalog", "_state"):
        p = manifests_root(skill_dir) / sub
        if p.exists():
            shutil.rmtree(p)

    base_all = {}
    overrides_all = {r: {} for r in releases}

    for pub in sorted(all_pubs):
        base = {}
        overrides = {r: {} for r in releases}
        all_paths = set()
        for r in releases:
            all_paths.update(per_release_pages[r].get(pub, {}).keys())

        for path in all_paths:
            variants = {}
            for r in releases:
                entry = per_release_pages[r].get(pub, {}).get(path)
                if entry is not None:
                    key = json.dumps(entry, sort_keys=True)
                    variants.setdefault(key, []).append(r)
            if len(variants) == 1:
                key, rels = next(iter(variants.items()))
                base[path] = {**json.loads(key), "releases": sorted(rels)}
            else:
                for r in releases:
                    entry = per_release_pages[r].get(pub, {}).get(path)
                    if entry is not None:
                        overrides[r][path] = entry

        base_all[pub] = base
        for r in releases:
            if overrides[r]:
                overrides_all[r][pub] = overrides[r]
            combined = {p: {k: e[k] for k in TRIMMED_FIELDS} for p, e in base.items() if r in e.get("releases", [])}
            combined.update(overrides[r])
            if combined:
                update_catalog_entry(skill_dir, r, pub, len(combined), len(combined) - len(overrides[r]), len(overrides[r]), combined)

    save_base(skill_dir, base_all)
    for r in releases:
        save_overrides(skill_dir, r, overrides_all[r])

    for r in releases:
        save_json(manifests_root(skill_dir) / "_state" / f"{r}.json",
                   {"release": r, "branch": r, "last_indexed_commit": commits[r],
                    "last_synced": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    restored = restore_curated_descriptions(skill_dir, curated)
    if restored:
        print(f"Restored {restored} hand-curated catalog description(s) across "
              f"{len(curated)} release(s).", file=sys.stderr)

    report_size(skill_dir)


def report_size(skill_dir):
    total = 0
    file_count = 0
    pycache = 0
    for p in Path(skill_dir).rglob("*"):
        if p.is_file() and ".checkouts" not in p.parts:
            total += p.stat().st_size
            file_count += 1
            if "__pycache__" in p.parts:
                pycache += 1
    print(f"\nTotal package size: {total/1e6:.1f} MB across {file_count} files", file=sys.stderr)
    # Running these scripts in place creates __pycache__ inside the skill
    # directory. Those files are real as far as the Skills API is concerned,
    # so they eat file-count headroom for nothing. Counted, not hidden.
    if pycache:
        print(f"{pycache} of those are __pycache__ files - delete them before packaging "
              f"(find . -name __pycache__ -type d | xargs rm -rf).", file=sys.stderr)
    if total > SKILL_SIZE_CAP_BYTES:
        print(f"OVER the 30MB Skills API size cap by {(total-SKILL_SIZE_CAP_BYTES)/1e6:.1f}MB, package will not upload as-is.", file=sys.stderr)
    elif total > SKILL_SIZE_WARN_BYTES:
        print(f"Approaching the 30MB size cap ({(SKILL_SIZE_CAP_BYTES-total)/1e6:.1f}MB headroom left).", file=sys.stderr)
    if file_count > SKILL_FILE_COUNT_CAP:
        print(f"OVER the 200-file Skills API cap by {file_count - SKILL_FILE_COUNT_CAP} files, package will not upload as-is.", file=sys.stderr)
    elif file_count > SKILL_FILE_COUNT_WARN:
        print(f"Approaching the 200-file cap ({SKILL_FILE_COUNT_CAP - file_count} files of headroom left).", file=sys.stderr)
    return total, file_count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("release", nargs="?", help="Release to sync incrementally, e.g. australia")
    parser.add_argument("--branch", default=None)
    parser.add_argument("--repo-url", default=DEFAULT_REPO_URL)
    parser.add_argument("--full-reconcile", nargs="+", metavar="RELEASE", help="Rebuild base+overrides from scratch across these releases")
    parser.add_argument("--check-size", action="store_true", help="Just report current total manifest size")
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent

    if args.check_size:
        report_size(skill_dir)
        return
    if args.full_reconcile:
        full_reconcile(args.full_reconcile, args.repo_url, skill_dir)
        return
    if not args.release:
        parser.error("provide a release name, or use --full-reconcile / --check-size")
    sync_incremental(args.release, args.branch, args.repo_url, skill_dir)
    report_size(skill_dir)


if __name__ == "__main__":
    main()
