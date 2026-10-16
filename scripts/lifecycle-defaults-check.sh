#!/usr/bin/env bash
# Has a lifecycle default that an earlier release shipped changed since? (E134)
#
# yadflow ships its lifecycle as `cli/lifecycle/defaults/<n>.json`. A team's own lifecycle file will
# record which default it was copied from (`extends: "yadflow-default@<n>"`), and `yad lifecycle upgrade`
# (E141) merges three versions: that old default, the team's file, and the new default. The merge is only
# right if the old default is exactly what the team copied. So a default, once released, never changes:
# a change to the default is a new file with the next number.
#
# What this checks:
#   - for every release tag (`v*`), every default file that tag carried is byte-identical today;
#   - the files are numbered 1..N with no gap, and each says which one it is (`extends`).
# It refuses to pass when it cannot see the tags (a shallow clone, or none fetched): "nothing to compare"
# must never read as "nothing changed".
#
# Split out of release-check.sh so it can be run on its own:
#   bash scripts/lifecycle-defaults-check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

die() { printf '\nRELEASE CHECK FAILED: %s\n' "$*" >&2; exit 1; }

DIR=cli/lifecycle/defaults

[ "$(git rev-parse --is-shallow-repository)" = "false" ] \
  || die "this is a shallow clone, so the earlier releases cannot be compared — fetch the full history (fetch-depth: 0) and the tags"
TAGS="$(git tag -l 'v*')"
[ -n "$TAGS" ] || die "no release tags (v*) are visible, so the earlier releases cannot be compared — run: git fetch --tags"

checked=0
for tag in $TAGS; do
  # The default files that tag carried, if any (every release before E134 carried none).
  files="$(git ls-tree --name-only "$tag" "$DIR/" 2>/dev/null || true)"
  for f in $files; do
    case "$f" in *.json) ;; *) continue ;; esac
    [ -f "$f" ] || die "$f shipped in $tag and has been deleted — a released default stays in the package for good"
    then_blob="$(git rev-parse "$tag:$f")"
    now_blob="$(git hash-object "$f")"
    [ "$then_blob" = "$now_blob" ] \
      || die "$f has changed since $tag shipped it — put the change in a new default (the next number) and restore it: git checkout $tag -- $f"
    checked=$((checked + 1))
  done
done

# The numbering, and each file's own name for itself.
node --input-type=module -e '
  import fs from "node:fs";
  const dir = process.argv[1];
  const nums = fs.readdirSync(dir).map((f) => /^([1-9]\d*)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  if (!nums.length) { console.error("   no default files found in " + dir); process.exit(1); }
  nums.forEach((n, i) => {
    if (n !== i + 1) { console.error(`   the defaults skip a number: expected ${i + 1}.json, found ${n}.json`); process.exit(1); }
    const ext = JSON.parse(fs.readFileSync(`${dir}/${n}.json`, "utf8")).extends;
    if (ext !== `yadflow-default@${n}`) { console.error(`   ${n}.json says extends "${ext}", not "yadflow-default@${n}"`); process.exit(1); }
  });
  console.log(`   ${nums.length} default(s): ${nums.map((n) => n + ".json").join(", ")}`);
' "$DIR" || die "the lifecycle defaults are not numbered 1..N, each naming itself — see above"

printf '   ok: %s released default file(s) compared across %s tag(s); none changed\n' "$checked" "$(printf '%s\n' "$TAGS" | wc -l | tr -d ' ')"
