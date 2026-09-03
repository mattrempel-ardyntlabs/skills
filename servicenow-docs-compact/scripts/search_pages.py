#!/usr/bin/env python3
"""
search_pages.py - Search one publication's manifest data (base + this
release's overrides, merged) by keyword, without ever loading the full file
into an LLM context window. base.json alone can run ~19MB; this script loads
it once, filters in a subprocess, and prints only the matches for the one
publication asked about.

Usage:
    python3 search_pages.py <release> <publication> <keyword> [<keyword> ...] [--limit N]

Example:
    python3 search_pages.py zurich build-workflows "scheduled trigger" flow --limit 10

Matching: case-insensitive word-boundary match against title + description.
Ranking: title matches count double a description-only match; ties broken by
shorter description first (tends to surface overview-style pages).
Output: JSON list of {path, title, description, topic_type}, most relevant first.

ACRONYM/SYNONYM EXPANSION: before matching, each input keyword is checked
against manifests/_synonyms.json. If it matches a known ServiceNow acronym or
shorthand term, every other term in that group is added to the search at full
weight (not a weaker fallback). This matters because the acronym itself
often never appears in the actual doc title/description at all. Example: a
search for "MACD" alone will never match "Customer Life Cycle Management
Workflows" (the page that implements MACD), because that page's title and
description never use the letters "MACD", only "modify/suspend/resume/
disconnect" and "sold product". The synonym group maps MACD to those actual
terms, not to a literal expansion of the acronym's letters (which was tried
and failed: "move add change disconnect" is generic enough to match unrelated
task docs instead of the right page). Applied expansions are reported in the
output under "expansions_applied" so it's visible when this fires.

Note on file layout: base and overrides are each ONE consolidated file
(manifests/base.json, manifests/overrides/<release>.json), not one file per
publication. The Skills API's 200-file cap ruled out per-publication files
at this scale (63 publications x 4 tiers = 252 manifest files, 263 with
support files). This script loads the whole consolidated file then indexes
into the one publication key it needs; still much cheaper than putting that
data in front of an LLM directly.

NULL-SAFETY (added after a live failure): ServiceNow ships pages whose YAML
frontmatter has an empty `title:` or `description:` key. PyYAML parses those
as None, and sync_release.py used to store them as JSON null. Reading
entry["title"].lower() on those raised AttributeError and killed the whole
search. That was not rare: it crashed servicenow-platform,
it-service-management, employee-service-management and integrate-applications,
four of the most-used publications. sync_release.py now coerces to "" at
write time, and every read here is defensive too, so already-indexed nulls
in an older manifest can't reintroduce the crash.
"""
import argparse
import json
import re
import sys
from difflib import get_close_matches
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest_io as mio

# Markdown escaping leaks out of ServiceNow's frontmatter into ~1,400 titles
# (e.g. "Now Assist for Configure, Price, Quote \\(CPQ\\)"). Stripped for
# display only; matching is unaffected either way because backslashes and
# parens are both non-word characters as far as \b is concerned.
MD_ESCAPE = re.compile(r"\\([()\[\]*_`~#+\-.!])")


def clean(value):
    """Coerce a possibly-null manifest field to a display-ready string."""
    if not value:
        return ""
    return MD_ESCAPE.sub(r"\1", str(value))


def load_json(path, default):
    path = Path(path)
    return json.loads(path.read_text()) if path.exists() else default


def load_synonym_lookup(skill_dir):
    """Returns {lowercase_term: set of other lowercase terms in its group}."""
    data = load_json(skill_dir / "manifests" / "_synonyms.json", {"groups": []})
    lookup = {}
    for group in data.get("groups", []):
        group_l = [t.lower() for t in group]
        for term in group_l:
            lookup[term] = set(group_l) - {term}
    return lookup


def expand_keywords(keywords, synonym_lookup):
    """Returns (expanded_keyword_list, {original_keyword: [added terms]})."""
    expanded = list(keywords)
    applied = {}
    for kw in keywords:
        added = synonym_lookup.get(kw.lower())
        if added:
            seen = {e.lower() for e in expanded}
            new_terms = sorted(t for t in added if t not in seen)
            if new_terms:
                expanded.extend(new_terms)
                applied[kw] = new_terms
    return expanded, applied


def build_pattern(keyword):
    """Word-boundary regex, but only where the keyword's own edge is a word
    character. Unconditional \\b broke keywords that start or end with
    punctuation: "(quote)" compiled to \\b\\(quote\\)\\b, which can never match
    anything, so the search silently returned zero results instead of finding
    the quote pages."""
    escaped = re.escape(keyword)
    prefix = r"\b" if keyword[:1].isalnum() or keyword[:1] == "_" else ""
    suffix = r"\b" if keyword[-1:].isalnum() or keyword[-1:] == "_" else ""
    return re.compile(prefix + escaped + suffix)


def known_releases(skill_dir):
    data = load_json(skill_dir / "manifests" / "_supported_releases.json", {})
    return [r["release"] for r in data.get("supported_releases", []) if r.get("release")]


def fail(payload):
    print(json.dumps(payload, indent=2))
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("release")
    parser.add_argument("publication")
    parser.add_argument("keywords", nargs="+")
    parser.add_argument("--limit", type=int, default=15)
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent

    if args.limit < 1:
        fail({"error": f"--limit must be 1 or greater (got {args.limit})."})

    # Keywords that are empty or whitespace-only used to compile to \b\b, which
    # matches every entry and returned the entire publication as "results".
    keywords_in = [k.strip() for k in args.keywords if k and k.strip()]
    if not keywords_in:
        fail({"error": "No usable keywords supplied (all were empty or whitespace)."})

    # Validate the release before blaming the publication. Previously a typo'd
    # release produced "No data for publication 'order-management' in release
    # 'zurrich'", which points at the wrong thing entirely.
    releases = known_releases(skill_dir)
    if releases and args.release not in releases:
        fail({"error": f"Unknown release '{args.release}'. Tracked releases: {', '.join(sorted(releases))}. "
                       f"Do not substitute a different release's docs for an untracked one."})

    # Decode only this one publication. Under the encoded layout that means
    # reading one gzip blob rather than parsing all 18.93 MB of base data,
    # which is why compression made this faster instead of slower.
    base = mio.load_publication(skill_dir, "base", args.publication)
    override = mio.load_publication(skill_dir, "overrides", args.publication, release=args.release)

    combined = {}
    for path, entry in base.items():
        if args.release in entry.get("releases", []):
            combined[path] = {
                "title": clean(entry.get("title")),
                "description": clean(entry.get("description")),
                "topic_type": entry.get("topic_type") or "",
            }
    for path, entry in override.items():  # overrides always win for this release
        combined[path] = {
            "title": clean(entry.get("title")),
            "description": clean(entry.get("description")),
            "topic_type": entry.get("topic_type") or "",
        }

    if not combined:
        catalog = load_json(skill_dir / "manifests" / "catalog" / f"{args.release}.json", {})
        suggestions = get_close_matches(args.publication, list(catalog), n=5, cutoff=0.4)
        err = {"error": f"No data for publication '{args.publication}' in release '{args.release}'. "
                        f"Publication names are lowercase and hyphenated.",
               "catalog": f"manifests/catalog/{args.release}.json ({len(catalog)} publications)"}
        if suggestions:
            err["did_you_mean"] = suggestions
        fail(err)

    synonym_lookup = load_synonym_lookup(skill_dir)
    expanded_keywords, expansions_applied = expand_keywords(keywords_in, synonym_lookup)
    original_l = {k.lower() for k in keywords_in}
    keywords = [k.lower() for k in expanded_keywords]
    compiled = [build_pattern(k) for k in keywords]

    # Expansion-derived terms are weighted higher than raw literal keywords.
    # Rationale: when "MACD" expands to "customer life cycle management", that
    # phrase IS the actual signal, so it should win even if some other doc
    # coincidentally matches more of the original bare words (e.g. a generic
    # "add a sold product" task doc matching literal "add"). Without this
    # boost, noisy short literal keywords passed alongside an acronym can
    # outscore the one doc that actually represents what the acronym means.
    TITLE_WEIGHT_LITERAL, DESC_WEIGHT_LITERAL = 2, 1
    TITLE_WEIGHT_EXPANDED, DESC_WEIGHT_EXPANDED = 4, 2

    scored = []
    for path, entry in combined.items():
        title_l = entry["title"].lower()
        desc_l = entry["description"].lower()
        score = 0
        for k, pattern in zip(keywords, compiled):
            tw, dw = (TITLE_WEIGHT_LITERAL, DESC_WEIGHT_LITERAL) if k in original_l else (TITLE_WEIGHT_EXPANDED, DESC_WEIGHT_EXPANDED)
            if pattern.search(title_l):
                score += tw
            if pattern.search(desc_l):
                score += dw
        if score > 0:
            scored.append((score, len(desc_l), path, entry))

    scored.sort(key=lambda x: (-x[0], x[1], x[2]))
    results = [{"path": path, **entry} for _, _, path, entry in scored[: args.limit]]
    output = {"publication": args.publication, "release": args.release,
              "match_count": len(scored), "results": results}
    if expansions_applied:
        output["expansions_applied"] = expansions_applied
    if not scored:
        output["hint"] = ("No matches. Try plain descriptive wording that mirrors ServiceNow doc titles "
                          "(\"Managing X\", \"Configure Y\"), check expansions_applied for acronym coverage, "
                          "or try a different publication from the catalog.")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
