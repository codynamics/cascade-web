"""CAS-1522: path allowlist for promote-data.yml.

Reads a newline-separated list of paths (the staged staging->main diff) on stdin and exits
non-zero if ANY path falls outside the catalogue data allowlist. Code files must never ride
the data-only promote to main.
"""
import sys

# Exact files and directory prefixes that production surfaces read live from cascademovies.com
# (app_template.html: CATALOGUE_POINTER_URL -> catalogue.json -> catalogue/<hash>.json).
ALLOWED_FILES = {"movies.json", "catalogue.json"}
ALLOWED_PREFIXES = ("catalogue/",)


def is_allowed(path):
    path = path.strip().replace("\\", "/")
    return path in ALLOWED_FILES or path.startswith(ALLOWED_PREFIXES)


def violations(paths):
    return [p.strip() for p in paths if p.strip() and not is_allowed(p)]


def main():
    bad = violations(sys.stdin.read().splitlines())
    if bad:
        print("promote-data guard: non-data paths in diff:", file=sys.stderr)
        for p in bad:
            print("  " + p, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
