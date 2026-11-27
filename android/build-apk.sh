#!/bin/sh
# Builds the reader app. The finished APK is put next to this script as
# shelfmark-reader.apk, ready to copy to a phone and open there.
#
#   android/build-apk.sh             build it
#   android/build-apk.sh --publish   also copy it into ../public, so Shelfmark
#                                    itself offers it for download (Collection,
#                                    then Reader app)
#
# Needs the Android SDK (Android Studio brings it) and Java 17 or newer.
set -e
cd "$(dirname "$0")"

# Android Studio comes with a Java of its own; use it when no other is set.
if [ -z "$JAVA_HOME" ]; then
  for candidate in "/Applications/Android Studio.app/Contents/jbr/Contents/Home" "$HOME/android-studio/jbr" "/opt/android-studio/jbr"; do
    if [ -x "$candidate/bin/java" ]; then
      export JAVA_HOME="$candidate"
      break
    fi
  done
fi

# Gradle looks for the SDK in local.properties or ANDROID_HOME.
if [ ! -f local.properties ] && [ -z "$ANDROID_HOME" ]; then
  for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [ -d "$candidate" ]; then
      export ANDROID_HOME="$candidate"
      break
    fi
  done
fi

./gradlew --console=plain :app:testDebugUnitTest :app:assembleRelease
cp app/build/outputs/apk/release/app-release.apk shelfmark-reader.apk
echo "Built $(pwd)/shelfmark-reader.apk"

if [ "$1" = "--publish" ]; then
  cp shelfmark-reader.apk ../public/shelfmark-reader.apk
  echo "Copied to public/shelfmark-reader.apk: Shelfmark now offers it under Collection, Reader app."
fi
