#!/usr/bin/env bash
#
# release-mac.sh - build, sign (Developer ID) and notarize the macOS build
# (universal DMG + ZIP), then optionally upload it to the GitHub release
# v<version>, creating a draft release if there is none yet.
#
# Required env: MAC_CERT_P12, MAC_CERT_PASSWORD, APPLE_API_KEY,
#   APPLE_API_KEY_ID, APPLE_API_ISSUER.
# Optional: UPLOAD_RELEASE=1 (+ GH_TOKEN with repo scope, or a logged-in gh).
set -euo pipefail

REPO="Alexandr-Kravchuk/screen-dimmer"
log() { printf '\n\033[1;34m> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mx %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || die "This script must run on macOS."
for t in xcrun security codesign node; do command -v "$t" >/dev/null || die "$t not found."; done

: "${MAC_CERT_P12:?Set MAC_CERT_P12 to the Developer ID Application .p12}"
: "${MAC_CERT_PASSWORD:?Set MAC_CERT_PASSWORD to the .p12 password}"
: "${APPLE_API_KEY:?Set APPLE_API_KEY to the App Store Connect .p8 key}"
: "${APPLE_API_KEY_ID:?Set APPLE_API_KEY_ID}"
: "${APPLE_API_ISSUER:?Set APPLE_API_ISSUER}"
[[ -f "$MAC_CERT_P12" ]]  || die "Certificate not found: $MAC_CERT_P12"
[[ -f "$APPLE_API_KEY" ]] || die "API key not found: $APPLE_API_KEY"

cd "$(dirname "$0")/.."
[[ -d node_modules ]] || die "Run 'npm ci' first."
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
log "Releasing macOS build for $TAG"

# -- throwaway keychain -------------------------------------------------------
KEYCHAIN_DIR="$(mktemp -d)"
KEYCHAIN="$KEYCHAIN_DIR/release.keychain-db"
KEYCHAIN_PASSWORD="$(uuidgen)"
ORIG_KEYCHAINS=()
while IFS= read -r _kc; do
  _kc="${_kc#"${_kc%%[![:space:]]*}"}"; _kc="${_kc#\"}"; _kc="${_kc%\"}"
  [[ -n "$_kc" ]] && ORIG_KEYCHAINS+=("$_kc")
done < <(security list-keychains -d user)

cleanup() {
  set +e
  [[ ${#ORIG_KEYCHAINS[@]} -gt 0 ]] && security list-keychains -d user -s "${ORIG_KEYCHAINS[@]}" >/dev/null 2>&1
  [[ -f "$KEYCHAIN" ]] && security delete-keychain "$KEYCHAIN" >/dev/null 2>&1
  rm -rf "$KEYCHAIN_DIR" >/dev/null 2>&1
}
trap cleanup EXIT

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"   # stays unlocked during notarization
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$MAC_CERT_P12" -k "$KEYCHAIN" -P "$MAC_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S "apple-tool:,apple:,codesign:" -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
security list-keychains -d user -s "$KEYCHAIN" "${ORIG_KEYCHAINS[@]}"

IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | awk '/Developer ID Application/ {print $2; exit}')"
[[ -n "$IDENTITY" ]] || die "No 'Developer ID Application' identity in $MAC_CERT_P12"
log "Signing identity: $IDENTITY"

# -- build + sign + notarize --------------------------------------------------
rm -rf dist/mac-universal dist/mac-universal-*-temp
rm -f dist/*.dmg dist/*.dmg.blockmap dist/*-mac-*.zip dist/*-mac-*.zip.blockmap dist/latest-mac.yml
export CSC_KEYCHAIN="$KEYCHAIN"
npx --no-install electron-builder --mac --publish never \
  --config.mac.identity="$IDENTITY" \
  --config.mac.notarize=true

APP_PATH="$(find dist/mac-universal -maxdepth 1 -name '*.app' -type d | head -1)"
[[ -n "$APP_PATH" ]] || die "No .app in dist/mac-universal."
log "Verifying $APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
spctl -a -vvv -t execute "$APP_PATH"

shopt -s nullglob
ASSETS=(dist/*.dmg dist/*-mac-*.zip)
shopt -u nullglob
[[ ${#ASSETS[@]} -eq 2 ]] || die "Expected a DMG and a ZIP, found: ${ASSETS[*]:-none}"
log "Signed + notarized: ${ASSETS[*]}"

# -- upload -------------------------------------------------------------------
[[ "${UPLOAD_RELEASE:-}" == "1" ]] || exit 0
command -v gh >/dev/null || die "gh CLI not found."
GH_TOKEN="${GH_TOKEN:-$(gh auth token)}"

RELID="$(gh api "repos/$REPO/releases" --paginate --jq ".[] | select(.tag_name==\"$TAG\") | .id" | head -1)"
if [[ -z "$RELID" ]]; then
  log "No release for $TAG yet - creating a draft"
  RELID="$(gh api --method POST "repos/$REPO/releases" -f tag_name="$TAG" -f name="Screen Dimmer $VERSION" \
    -F draft=true -F generate_release_notes=true --jq '.id')"
fi

# Large uploads can stall with HTTP 408; IPv4 + HTTP/1.1 with retries is reliable.
upload_asset() {
  local file="$1" name existing code attempt
  name="$(basename "$file")"
  for attempt in 1 2 3; do
    existing="$(gh api "repos/$REPO/releases/$RELID/assets" --jq ".[] | select(.name==\"$name\") | .id")"
    [[ -n "$existing" ]] && gh api --method DELETE "repos/$REPO/releases/assets/$existing" >/dev/null 2>&1 || true
    code="$(curl -4 --http1.1 -sS -X POST -H "Authorization: Bearer $GH_TOKEN" \
      -H "Content-Type: application/octet-stream" -T "$file" \
      "https://uploads.github.com/repos/$REPO/releases/$RELID/assets?name=$name" \
      -o /dev/null -w "%{http_code}")" || code="curl-error"
    printf '  %s: HTTP %s (attempt %s)\n' "$name" "$code" "$attempt"
    [[ "$code" == "201" ]] && return 0
    sleep 5
  done
  die "Upload of $name failed (last: HTTP $code)."
}
for f in "${ASSETS[@]}"; do upload_asset "$f"; done

STATES="$(gh api "repos/$REPO/releases/$RELID/assets" --jq '.[] | "\(.name) \(.state)"')"
for f in "${ASSETS[@]}"; do
  grep -qx "$(basename "$f") uploaded" <<<"$STATES" || die "$(basename "$f") is not uploaded:"$'\n'"$STATES"
done
log "macOS assets uploaded to $TAG (release id $RELID)."
