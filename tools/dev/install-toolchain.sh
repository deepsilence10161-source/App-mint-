#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Install the Android toolchain locally, so a generated project can be compiled
# on this machine instead of waiting for CI.
#
# This is a convenience for whoever is working on the engine. Nothing in the
# product depends on it: the apps are built by the workflows, and the device
# test runs on a hosted emulator with hardware acceleration. This script exists
# so that "does it still compile?" can be answered in a minute rather than in a
# fifteen-minute CI round trip.
#
# Installs into /opt, which is where a Debian sandbox expects system software.
# Override with PREFIX if you would rather keep it somewhere else.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PREFIX="${PREFIX:-/opt}"
JDK_DIR="$PREFIX/jdk17"
SDK_DIR="$PREFIX/asdk"
GRADLE_DIR="$PREFIX/gradle"
GH="$PREFIX/gradle-home"
DL="$PREFIX/dl"

GRADLE_VERSION="${GRADLE_VERSION:-8.13}"
BUILD_TOOLS="${BUILD_TOOLS:-36.0.0}"
PLATFORM="${PLATFORM:-android-36}"

say() { printf '  %s\n' "$*"; }

say "installing into $PREFIX"
sudo mkdir -p "$JDK_DIR" "$SDK_DIR/cmdline-tools" "$GRADLE_DIR" "$GH" "$DL"
sudo chown -R "$(id -u):$(id -g)" "$JDK_DIR" "$SDK_DIR" "$GRADLE_DIR" "$GH" "$DL"
cd "$DL"

say "JDK 17"
[ -x "$JDK_DIR/bin/javac" ] || {
  curl -sSL -o jdk.tar.gz "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
  tar xzf jdk.tar.gz -C "$JDK_DIR" --strip-components=1
  rm -f jdk.tar.gz
}
export JAVA_HOME="$JDK_DIR"

say "Android command-line tools"
if [ ! -x "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" ]; then
  curl -sSL -o clt.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  unzip -q -o clt.zip -d "$SDK_DIR/cmdline-tools"
  [ -d "$SDK_DIR/cmdline-tools/cmdline-tools" ] && mv "$SDK_DIR/cmdline-tools/cmdline-tools" "$SDK_DIR/cmdline-tools/latest"
  rm -f clt.zip
fi

say "Gradle $GRADLE_VERSION"
if [ ! -x "$GRADLE_DIR/gradle-$GRADLE_VERSION/bin/gradle" ]; then
  curl -sSL -o gradle.zip "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip"
  unzip -q -o gradle.zip -d "$GRADLE_DIR"
  rm -f gradle.zip
fi

export ANDROID_HOME="$SDK_DIR" ANDROID_SDK_ROOT="$SDK_DIR" GRADLE_USER_HOME="$GH"
export PATH="$SDK_DIR/cmdline-tools/latest/bin:$SDK_DIR/platform-tools:$GRADLE_DIR/gradle-$GRADLE_VERSION/bin:$JAVA_HOME/bin:$PATH"

say "SDK packages"
yes | sdkmanager --licenses > /dev/null 2>&1 || true
sdkmanager "platform-tools" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" > /dev/null

cat <<NEXT

  Ready. For this shell:

    export JAVA_HOME=$JDK_DIR
    export ANDROID_HOME=$SDK_DIR ANDROID_SDK_ROOT=$SDK_DIR
    export GRADLE_USER_HOME=$GH
    export PATH="$SDK_DIR/platform-tools:$GRADLE_DIR/gradle-$GRADLE_VERSION/bin:\$JAVA_HOME/bin:\$PATH"

  Then, to compile a generated project:

    node engine/cli.mjs generate apps/native-demo/spec.json --out build/native
    echo "sdk.dir=$SDK_DIR" > build/native/android/local.properties
    (cd build/native/android && gradle assembleDebug)

  This machine has no /dev/kvm, so the app cannot be RUN here — only compiled.
  The device test runs in CI, where KVM is available.

NEXT
