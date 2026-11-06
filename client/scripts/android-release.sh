#!/bin/bash
set -euo pipefail

CLIENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="$CLIENT_DIR/build/android"
SIGNING_DIR="${PANECAST_ANDROID_SIGNING_DIR:-$HOME/.cmuxremote/android-release}"
KEYSTORE="$SIGNING_DIR/panecast-release.p12"
PASSWORD_FILE="$SIGNING_DIR/password"
ACTION="${1:-build}"

case "$ACTION" in
  init-key|build) ;;
  *) printf 'Usage: %s [init-key|build]\n' "$0" >&2; exit 1 ;;
esac

if [[ "$ACTION" == init-key ]]; then
  if [[ -e "$KEYSTORE" || -e "$PASSWORD_FILE" ]]; then
    printf 'Signing material already exists at %s; refusing to replace it.\n' "$SIGNING_DIR" >&2
    exit 1
  fi
  umask 077
  mkdir -p "$SIGNING_DIR"
  chmod 700 "$SIGNING_DIR"
  openssl rand -hex 32 > "$PASSWORD_FILE"
  keytool -genkeypair -noprompt -storetype PKCS12 \
    -keystore "$KEYSTORE" -alias panecast -keyalg RSA -keysize 3072 \
    -validity 10000 -dname 'CN=Panecast, O=Panecast' \
    -storepass:file "$PASSWORD_FILE" -keypass:file "$PASSWORD_FILE"
  printf 'Signing key created at %s. Back up this directory privately.\n' "$SIGNING_DIR"
  exit 0
fi

if [[ ! -f "$KEYSTORE" || ! -f "$PASSWORD_FILE" ]]; then
  printf 'Missing release key. Run npm run android:release -- init-key once.\n' >&2
  exit 1
fi

ANDROID_SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BUILD_TOOLS_VERSION="${PANECAST_ANDROID_BUILD_TOOLS:-36.0.0}"
BUILD_TOOLS="$ANDROID_SDK_DIR/build-tools/$BUILD_TOOLS_VERSION"
for tool in apksigner zipalign aapt; do
  [[ -x "$BUILD_TOOLS/$tool" ]] || { printf 'Missing %s/%s\n' "$BUILD_TOOLS" "$tool" >&2; exit 1; }
done

cd "$CLIENT_DIR"
APP_VERSION="$(node -p 'require("./app.json").expo.version')"
BUILD_NUMBER="$(node -p 'require("./app.json").expo.android.versionCode')"
APK_NAME="panecast-$APP_VERSION-$BUILD_NUMBER-arm64.apk"
mkdir -p "$OUTPUT_DIR"

# Native files remain generated. Release signing happens on a separate copy,
# using a persistent private key rather than the template's debug certificate.
npx expo prebuild --platform android --no-install
(
  cd android
  ANDROID_HOME="$ANDROID_SDK_DIR" NODE_ENV=production ./gradlew :app:assembleRelease \
    -PreactNativeArchitectures=arm64-v8a --console=plain
)

"$BUILD_TOOLS/zipalign" -f -P 16 4 \
  android/app/build/outputs/apk/release/app-release.apk "$OUTPUT_DIR/aligned.apk"
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-key-alias panecast \
  --ks-pass "file:$PASSWORD_FILE" \
  --v4-signing-enabled false --out "$OUTPUT_DIR/$APK_NAME" "$OUTPUT_DIR/aligned.apk"
"$BUILD_TOOLS/apksigner" verify --verbose --print-certs "$OUTPUT_DIR/$APK_NAME"
"$BUILD_TOOLS/zipalign" -c -P 16 4 "$OUTPUT_DIR/$APK_NAME"
"$BUILD_TOOLS/aapt" dump badging "$OUTPUT_DIR/$APK_NAME" | \
  sed -n '/^package:/p; /^sdkVersion:/p; /^targetSdkVersion:/p; /^native-code:/p'
(
  cd "$OUTPUT_DIR"
  shasum -a 256 "$APK_NAME" > "$APK_NAME.sha256"
)
printf '\nRelease APK: %s/%s\n' "$OUTPUT_DIR" "$APK_NAME"
