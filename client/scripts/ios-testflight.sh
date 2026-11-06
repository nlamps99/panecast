#!/bin/bash
set -euo pipefail

CLIENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="$CLIENT_DIR/build/ios"
ARCHIVE_PATH="$OUTPUT_DIR/Panecast.xcarchive"
ACTION="${1:-archive}"

case "$ACTION" in
  archive|export|upload) ;;
  *)
    printf 'Usage: %s archive|export|upload\n' "$0" >&2
    exit 1
    ;;
esac

cd "$CLIENT_DIR"

if [[ "$ACTION" == archive ]]; then
  if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
    printf 'Set APPLE_TEAM_ID to your paid Apple Developer team ID.\n' >&2
    exit 1
  fi

  # Native projects are generated from app.json, including the build number.
  npx expo prebuild --platform ios
  mkdir -p "$OUTPUT_DIR"
  xcodebuild \
    -workspace ios/Panecast.xcworkspace \
    -scheme Panecast \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_PATH" \
    -derivedDataPath "$OUTPUT_DIR/DerivedData" \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
    CODE_SIGN_STYLE=Automatic \
    archive
  printf '\nArchive: %s\n' "$ARCHIVE_PATH"
  exit 0
fi

if [[ ! -d "$ARCHIVE_PATH" ]]; then
  printf 'Archive missing. Run APPLE_TEAM_ID=YOUR_TEAM_ID npm run ios:archive first.\n' >&2
  exit 1
fi

# Let Xcode use the archive's team and the account signed in to Xcode.
OPTIONS_PATH="$OUTPUT_DIR/ExportOptions-$ACTION.plist"
cat > "$OPTIONS_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$ACTION</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
EOF

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$OUTPUT_DIR/$ACTION" \
  -exportOptionsPlist "$OPTIONS_PATH" \
  -allowProvisioningUpdates
