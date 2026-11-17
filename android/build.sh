#!/usr/bin/env bash
# Builds dist/Randomizer.apk without Gradle, using the Android SDK build tools.
#   ANDROID_HOME   path to the Android SDK (needs platforms;android-34 and build-tools;35.0.0)
#   KEYSTORE       signing keystore (defaults to android/release.keystore, created if missing)
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
BT="$SDK/build-tools/35.0.0"
JAR="$SDK/platforms/android-34/android.jar"
KEYSTORE="${KEYSTORE:-release.keystore}"
KS_PASS="${KS_PASS:-randomizer}"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0}"
OUT=build
rm -rf "$OUT" && mkdir -p "$OUT/classes" "$OUT/assets/web" "$OUT/gen" "$OUT/dex"

cp -r ../web/. "$OUT/assets/web/"

"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" --manifest AndroidManifest.xml \
  -A "$OUT/assets" --java "$OUT/gen" "$OUT/res.zip" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME"

javac --release 8 -nowarn -Xlint:-options -encoding UTF-8 -cp "$JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')
"$BT/d8" --release --min-api 24 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -j ../base.apk classes.dex)

"$BT/zipalign" -p -f 4 "$OUT/base.apk" "$OUT/aligned.apk"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KS_PASS" -keypass "$KS_PASS" -alias randomizer \
    -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=Randomizer" >/dev/null
fi
mkdir -p ../dist
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --v4-signing-enabled false --out ../dist/Randomizer.apk "$OUT/aligned.apk"
"$BT/apksigner" verify ../dist/Randomizer.apk
echo "Built dist/Randomizer.apk"
