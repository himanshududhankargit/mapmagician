#!/usr/bin/env bash
# Daily production monitor for www.mapmagician.in — run by
# .github/workflows/daily-monitor.yml. All checks are read-only HTTP requests
# against public endpoints. Exits with the number of failed checks (0 = green),
# which flips the workflow run red and triggers GitHub's failed-run email.

set -u
REPORT="monitor-report.txt"
FAILURES=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

log()  { echo "$1" | tee -a "$REPORT"; }
pass() { log "PASS  $1"; }
fail() { log "FAIL  $1"; FAILURES=$((FAILURES+1)); }

log "Map Magician daily monitor — $(date -u '+%Y-%m-%d %H:%M UTC')"
log "----------------------------------------------------------"

# 1a. Live map page
code=$(curl -sS -o "$TMP/maps.html" -w '%{http_code}' https://www.mapmagician.in/maps.html || echo 000)
if [ "$code" = "200" ]; then pass "maps.html HTTP 200"; else fail "maps.html HTTP $code"; fi

# 1b. Cache-buster (?v=NNN in the HTML) must match APP_VERSION in the served JS,
# otherwise returning visitors can run new HTML against a stale cached JS
# (dead buttons for up to 4h — the ?v= exists precisely to prevent this).
vhtml=$(grep -oE 'maps-app\.js\?v=[0-9]+' "$TMP/maps.html" | head -1 | grep -oE '[0-9]+$' || true)
curl -sS -o "$TMP/maps-app.js" https://www.mapmagician.in/maps-app.js || true
vjs=$(grep -oE "APP_VERSION = '[0-9]+'" "$TMP/maps-app.js" | head -1 | grep -oE '[0-9]+' || true)
if [ -n "$vhtml" ] && [ "$vhtml" = "$vjs" ]; then
    pass "version stamps match (?v=$vhtml == APP_VERSION '$vjs')"
else
    fail "version stamp mismatch: HTML ?v='$vhtml' vs JS APP_VERSION='$vjs'"
fi

# 1c. SEO site
code=$(curl -sSL -o /dev/null -w '%{http_code}' https://dpplans.com/ || echo 000)
if [ "$code" = "200" ]; then pass "dpplans.com HTTP 200"; else fail "dpplans.com HTTP $code"; fi

# 2. Layer metadata files: live, valid JSON, and same size as the repo copy.
# A live-vs-repo size mismatch means a publish commit landed in git but GitHub
# Pages has not deployed it (the "wedged Pages deploy" failure mode).
for f in d1 d2 d3; do
    url="https://www.mapmagician.in/data/database/$f.bin"
    code=$(curl -sS -o "$TMP/$f.bin" -w '%{http_code}' "$url" || echo 000)
    if [ "$code" != "200" ]; then fail "$f.bin HTTP $code"; continue; fi
    livesize=$(stat -c%s "$TMP/$f.bin")
    first=$(head -c 1 "$TMP/$f.bin")
    case "$first" in
        '{'|'[') pass "$f.bin HTTP 200, JSON, $livesize bytes";;
        *)       fail "$f.bin does not start with JSON (first byte: '$first')";;
    esac
    gzcode=$(curl -sS -o /dev/null -w '%{http_code}' "$url.gz" || echo 000)
    if [ "$gzcode" = "200" ]; then pass "$f.bin.gz HTTP 200"; else fail "$f.bin.gz HTTP $gzcode"; fi
    if [ -f "data/database/$f.bin" ]; then
        reposize=$(stat -c%s "data/database/$f.bin")
        if [ "$livesize" = "$reposize" ]; then
            pass "$f.bin live size matches repo ($reposize bytes)"
        else
            fail "$f.bin live size $livesize != repo size $reposize (Pages deploy may be wedged)"
        fi
    fi
done

# 3. Tile CDN signed-cookie layer: a cookieless request MUST be rejected (403).
# A 200 would mean CloudFront is serving paid tile data openly.
code=$(curl -sS -o /dev/null -w '%{http_code}' 'https://tiles.mapmagician.in/dpplans/update-app-tiles/update.png' || echo 000)
if [ "$code" = "403" ]; then
    pass "tile CDN rejects cookieless request (403 — signed cookies enforcing)"
elif [ "$code" = "200" ]; then
    fail "tile CDN served a tile WITHOUT cookies — signed-cookie layer is OPEN"
else
    fail "tile CDN unexpected HTTP $code (expected 403)"
fi

log "----------------------------------------------------------"
if [ "$FAILURES" -eq 0 ]; then
    log "ALL CHECKS PASSED"
else
    log "$FAILURES CHECK(S) FAILED"
fi
exit "$FAILURES"
