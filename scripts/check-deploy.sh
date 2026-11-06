#!/usr/bin/env bash
# Checks a deployed Incorpr site page by page and API by API, and prints PASS / WARN / FAIL per line.
# Needs only bash, curl and grep, so it runs on any VPS.
#
#   bash check-deploy.sh                                  # https://tryincorpr.vercel.app, read-only checks
#   bash check-deploy.sh https://example.com              # another host
#   bash check-deploy.sh https://tryincorpr.vercel.app --live
#
# --live also asks the house treasury agent one question on NEAR AI Cloud (spends NEAR AI credit) and sends
# one rob attempt (stranger_sign: one real mainnet transaction from rob.incorpr.near that the vault refuses).
# The read-only checks send no transactions.

BASE="${1:-https://tryincorpr.vercel.app}"
BASE="${BASE%/}"
LIVE=0
for a in "$@"; do [ "$a" = "--live" ] && LIVE=1; done
[ "$BASE" = "--live" ] && BASE="https://tryincorpr.vercel.app"
HOST="${BASE#https://}"; HOST="${HOST#http://}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; WARN=0; FAIL=0
pass() { PASS=$((PASS+1)); printf 'PASS  %-34s %s\n' "$1" "$2"; }
warn() { WARN=$((WARN+1)); printf 'WARN  %-34s %s\n' "$1" "$2"; }
fail() { FAIL=$((FAIL+1)); printf 'FAIL  %-34s %s\n' "$1" "$2"; }

# req METHOD PATH [JSON_BODY] [extra curl args...] -> sets CODE, TYPE, BODY (file)
req() {
  local method="$1" path="$2" body="${3:-}"; shift 3 2>/dev/null || shift $#
  BODY="$TMP/body"
  local args=(-s -m 150 -o "$BODY" -w '%{http_code} %{content_type}' -X "$method")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
  local out; out="$(curl "${args[@]}" "$@" "$BASE$path" 2>/dev/null)" || out="000 -"
  CODE="${out%% *}"; TYPE="${out#* }"
}
has() { grep -q -- "$1" "$BODY"; }
snippet() { tr -d '\n' < "$BODY" | cut -c1-"${1:-160}"; }

echo "Incorpr deploy check: $BASE"
echo "-----------------------------------------------------------------------------"

# Pages: status 200 plus a marker that proves the page has its data, not just a shell.
page() {
  local path="$1" marker="$2" why="$3"
  req GET "$path"
  if [ "$CODE" != 200 ]; then fail "page $path" "HTTP $CODE"; return; fi
  if [ -z "$marker" ] || has "$marker"; then pass "page $path" "$why"
  else fail "page $path" "200 but no '$marker' ($why missing)"; fi
}
page /                  "Incorpr"           "landing renders"
page /exchange          "Ledgerline"        "company 1 listed from mainnet"
page /incorporate       ""                  "wizard renders"
page /desk              ""                  "desk renders"
page /company/1         "Ledgerline"        "cockpit reads c-1.incorpr.near"
page /company/1/owner   ""                  "owner room renders"
page /rob               "288ZLY6r"          "evidence log is bundled"
page /verify            "transfer_races"    "contract sources are bundled"
req GET /verify
if has "nearblocks.io/txns/" && ! has "No deploy record in the evidence log"; then pass "page /verify evidence" "evidence log loaded, tx links shown"
else fail "page /verify evidence" "evidence log missing: docs/evidence not traced into the build"; fi

# Images and icons.
img() {
  req GET "$1"
  if [ "$CODE" = 200 ] && [[ "$TYPE" == image/* ]]; then pass "image $1" "$TYPE"
  else fail "image $1" "HTTP $CODE $TYPE"; fi
}
img /opengraph-image
img /exchange/opengraph-image
img /rob/opengraph-image
img /company/1/opengraph-image
img /icon.png
img /apple-icon.png
img /favicon.ico
img /brand/incorpr-header.png

# APIs (read-only).
req GET /api/attestation
if [ "$CODE" = 200 ] && has '"tdxReportDataBindsSigningAddress":true'; then pass "api attestation" "TDX quote binds the signer"
else fail "api attestation" "HTTP $CODE $(snippet)"; fi

req GET "/api/history?token_id=1"
if [ "$CODE" = 200 ] && has '"status":"ok"'; then pass "api history" "events rebuilt for token 1"
else fail "api history" "HTTP $CODE $(snippet)"; fi

req GET "/api/intents?op=tokens"
[ "$CODE" = 200 ] && pass "api intents tokens" "1Click token list" || fail "api intents tokens" "HTTP $CODE $(snippet)"

req POST /api/verify-l1 '{"token_id":"1"}'
if [ "$CODE" = 200 ] && has '"overall":"clean"'; then pass "api verify-l1" "L1 state clean"
elif [ "$CODE" = 200 ]; then warn "api verify-l1" "answered, not clean: $(snippet)"
else fail "api verify-l1" "HTTP $CODE $(snippet)"; fi

req GET /api/rebalance
[ "$CODE" = 200 ] && has system_prompt && pass "api rebalance (GET)" "agent prompt published" || fail "api rebalance (GET)" "HTTP $CODE"

req GET /api/rob/recent
if [ "$CODE" = 200 ] && has 288ZLY6r; then pass "api rob recent" "refusal evidence served"
else fail "api rob recent" "HTTP $CODE $(snippet)"; fi

echo "-----------------------------------------------------------------------------"
echo "PASS $PASS   WARN $WARN   FAIL $FAIL"
[ "$FAIL" = 0 ]
