#!/usr/bin/env python3
"""
manifest_io.py - Single place that knows how manifest data is stored on disk.

WHY THIS EXISTS
The manifests used to be plain JSON: manifests/base.json at 18.93 MB, plus
three ~2 MB override files, for a package total of 24.94 MB against the Skills
API's 30 MB cap. That left about 5 MB of headroom, which is not enough room to
add a fourth tracked release or absorb upstream growth.

Compressing per publication solves it. The obvious container was a zip archive
with one member per publication, but the Skills API rejects a package
containing any .zip file ("Zip cannot contain nested zip files"), because a
skill is itself uploaded as a zip. See references/architecture.md.

So the payload is gzipped per publication, base64-encoded, and stored inside an
ordinary .json file. Pure ASCII, same file types the skill already shipped, no
new upload capability required.

    manifests/base.enc.json
    {
      "format": "gzip+base64",
      "version": 1,
      "publications": {"<publication>": "<base64 of gzipped JSON>"}
    }

MEASURED RESULT
    package total   24.94 MB -> 5.80 MB   (headroom 5.1 MB -> 24.2 MB)
    read one pub      192 ms ->    11 ms

The read speedup is not incidental. The old code parsed all 18.93 MB of
base.json to use roughly 1% of it. Here only the requested publication's blob
is decoded, so compression made retrieval about 17 times faster rather than
slower.

BACKWARD COMPATIBILITY
Every read falls back to the plain .json file when the encoded one is absent,
so this module works against either layout and the change is reversible.
scripts/migrate_manifests.py converts in both directions.
"""
import base64
import gzip
import json
from pathlib import Path

FORMAT = "gzip+base64"
VERSION = 1
COMPRESS_LEVEL = 9


def manifests_root(skill_dir):
    return Path(skill_dir) / "manifests"


def tier_paths(skill_dir, tier, release=None):
    """Returns (encoded_path, plain_path) for a tier.
    tier is 'base' or 'overrides'."""
    root = manifests_root(skill_dir)
    if tier == "base":
        return root / "base.enc.json", root / "base.json"
    if tier == "overrides":
        if not release:
            raise ValueError("overrides tier requires a release")
        return root / "overrides" / f"{release}.enc.json", root / "overrides" / f"{release}.json"
    raise ValueError(f"unknown tier {tier!r}")


def encode_publication(pages):
    payload = json.dumps(pages, separators=(",", ":"), sort_keys=True).encode()
    return base64.b64encode(gzip.compress(payload, COMPRESS_LEVEL)).decode()


def decode_publication(blob):
    return json.loads(gzip.decompress(base64.b64decode(blob)))


def _read_json(path, default):
    path = Path(path)
    return json.loads(path.read_text()) if path.exists() else default


def load_publication(skill_dir, tier, publication, release=None):
    """Decode exactly one publication. This is the hot path for search: it
    avoids materialising the other 62 publications entirely."""
    enc_path, plain_path = tier_paths(skill_dir, tier, release)
    if Path(enc_path).exists():
        doc = _read_json(enc_path, {})
        blob = doc.get("publications", {}).get(publication)
        return decode_publication(blob) if blob else {}
    return _read_json(plain_path, {}).get(publication, {})


def list_publications_in(skill_dir, tier, release=None):
    """Publication names present in a tier, without decoding any payloads."""
    enc_path, plain_path = tier_paths(skill_dir, tier, release)
    if Path(enc_path).exists():
        return sorted(_read_json(enc_path, {}).get("publications", {}))
    return sorted(_read_json(plain_path, {}))


def load_all(skill_dir, tier, release=None):
    """Decode every publication. Used by sync, which rewrites whole tiers.
    Costs a second or two against a script that also clones a git repo."""
    enc_path, plain_path = tier_paths(skill_dir, tier, release)
    if Path(enc_path).exists():
        doc = _read_json(enc_path, {})
        return {pub: decode_publication(blob) for pub, blob in doc.get("publications", {}).items()}
    return _read_json(plain_path, {})


def save_all(skill_dir, tier, data, release=None):
    """Write a whole tier in encoded form. Publications with no pages are
    dropped rather than stored as empty objects."""
    enc_path, _ = tier_paths(skill_dir, tier, release)
    enc_path = Path(enc_path)
    enc_path.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "format": FORMAT,
        "version": VERSION,
        "publications": {pub: encode_publication(pages) for pub, pages in sorted(data.items()) if pages},
    }
    enc_path.write_text(json.dumps(doc, separators=(",", ":"), sort_keys=True))
    return enc_path


def active_format(skill_dir):
    """Which layout is actually in use, for reporting and self-tests."""
    enc_path, plain_path = tier_paths(skill_dir, "base")
    if Path(enc_path).exists():
        return FORMAT
    if Path(plain_path).exists():
        return "plain-json"
    return "missing"
