// Checks the native configuration of the app without an Expo account, a Mac
// or the Android SDK (TASK-056 requirement 2, ARCHITECTURE 4.81): what EAS
// Build would generate is generated here and read.
//
//   pnpm --filter mobile native:check            (prebuild both platforms + expo-doctor)
//   pnpm --filter mobile native:check --no-doctor
//
// 1. `expo config --type public` — the plugins resolve, the identifiers and
//    the update policy are what the release needs;
// 2. `expo prebuild --no-install --clean` for Android and iOS — the native
//    projects are generated (no `pod install`, no Gradle) and their
//    manifest and Info.plist are read for what push, the background task and
//    OTA need;
// 3. `expo-doctor` — the packages match SDK 57.
//
// The generated `android/` and `ios/` are removed afterwards (managed
// workflow: they are never committed), and `package.json`, which prebuild
// rewrites, is put back as it was.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const problems = [];
const isWindows = process.platform === "win32";

function run(command, commandArgs, options = {}) {
  console.log(`\n$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd: app,
    encoding: "utf8",
    shell: isWindows,
    env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1", ...options.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!options.quiet) process.stdout.write(out);
  return { status: result.status ?? 1, out, stdout: result.stdout ?? "" };
}

function expect(condition, message) {
  if (!condition) problems.push(message);
}

// 1. The public configuration.
const config = run("npx", ["expo", "config", "--type", "public", "--json"], { quiet: true });
let publicConfig = null;
try {
  publicConfig = JSON.parse(config.stdout.slice(config.stdout.indexOf("{")));
} catch {
  problems.push(`expo config failed:\n${config.out}`);
}
if (publicConfig) {
  const identifier = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
  expect(
    identifier.test(publicConfig.ios?.bundleIdentifier ?? ""),
    "ios.bundleIdentifier is empty or malformed",
  );
  expect(
    identifier.test(publicConfig.android?.package ?? ""),
    "android.package is empty or malformed",
  );
  expect(
    publicConfig.runtimeVersion?.policy === "appVersion",
    'runtimeVersion must be { "policy": "appVersion" }',
  );
  expect(
    (publicConfig.ios?.infoPlist?.UIBackgroundModes ?? []).includes("remote-notification"),
    "ios.infoPlist.UIBackgroundModes lacks remote-notification",
  );
  expect(
    !("buildNumber" in (publicConfig.ios ?? {})),
    "ios.buildNumber is EAS's (appVersionSource: remote)",
  );
  expect(
    !("versionCode" in (publicConfig.android ?? {})),
    "android.versionCode is EAS's (appVersionSource: remote)",
  );
  console.log(
    `expo config: ${publicConfig.name} ${publicConfig.version}, ios ${publicConfig.ios?.bundleIdentifier}, android ${publicConfig.android?.package}, runtime ${JSON.stringify(publicConfig.runtimeVersion)}`,
  );
}

// 2. Prebuild, both platforms, and read what was generated.
const packageJson = join(app, "package.json");
const packageBefore = readFileSync(packageJson, "utf8");
try {
  // Expo generates the iOS project on macOS and Linux only: on Windows it is
  // skipped and left to CI (Linux) — said so, not passed as checked.
  const platforms = isWindows ? ["android"] : ["android", "ios"];
  for (const platform of platforms) {
    const prebuild = run("npx", [
      "expo",
      "prebuild",
      "--no-install",
      "--clean",
      "--platform",
      platform,
    ]);
    expect(prebuild.status === 0, `expo prebuild --platform ${platform} failed`);
  }
  if (isWindows)
    console.log("\nios: not generated on Windows — the CI step (Linux) generates and reads it");
  const manifestPath = join(app, "android", "app", "src", "main", "AndroidManifest.xml");
  if (existsSync(manifestPath)) {
    const manifest = readFileSync(manifestPath, "utf8");
    // The permission to post notifications (Android 13+) and the FCM service
    // are declared by expo-notifications' own manifest, which Gradle merges
    // into the app's (TASK-075: checked here, not assumed).
    const library = readFileSync(
      join(
        dirname(require.resolve("expo-notifications/package.json")),
        "android",
        "src",
        "main",
        "AndroidManifest.xml",
      ),
      "utf8",
    );
    expect(
      library.includes("android.permission.POST_NOTIFICATIONS"),
      "expo-notifications declares no POST_NOTIFICATIONS",
    );
    expect(
      library.includes("com.google.firebase.MESSAGING_EVENT"),
      "expo-notifications declares no FCM service",
    );
    expect(manifest.includes("com.whatsapp"), "AndroidManifest.xml lacks the WhatsApp <queries>");
    expect(
      manifest.includes("expo.modules.updates.EXPO_RUNTIME_VERSION"),
      "AndroidManifest.xml lacks the runtime version of expo-updates",
    );
    expect(
      manifest.includes("android.permission.CAMERA"),
      "AndroidManifest.xml lacks the camera permission",
    );
    const gradle = readFileSync(join(app, "android", "app", "build.gradle"), "utf8");
    expect(
      gradle.includes('applicationId "kz.adclub.app"') ||
        gradle.includes("applicationId 'kz.adclub.app'"),
      "build.gradle has another applicationId",
    );
    console.log("android: manifest and build.gradle read");
  } else {
    problems.push("android/app/src/main/AndroidManifest.xml was not generated");
  }
  const plistPath = join(app, "ios", "AsiaDriveClub", "Info.plist");
  if (isWindows) {
    // Above.
  } else if (existsSync(plistPath)) {
    const plist = readFileSync(plistPath, "utf8");
    expect(
      /<key>UIBackgroundModes<\/key>\s*<array>[\s\S]*?remote-notification/.test(plist),
      "Info.plist lacks UIBackgroundModes remote-notification",
    );
    expect(plist.includes("NSCameraUsageDescription"), "Info.plist lacks NSCameraUsageDescription");
    expect(plist.includes("whatsapp"), "Info.plist lacks LSApplicationQueriesSchemes");
    const expoPlist = join(app, "ios", "AsiaDriveClub", "Supporting", "Expo.plist");
    expect(
      existsSync(expoPlist) && readFileSync(expoPlist, "utf8").includes("EXUpdatesRuntimeVersion"),
      "Expo.plist lacks EXUpdatesRuntimeVersion",
    );
    const entitlements = join(app, "ios", "AsiaDriveClub", "AsiaDriveClub.entitlements");
    expect(
      existsSync(entitlements) && readFileSync(entitlements, "utf8").includes("aps-environment"),
      "the entitlements lack aps-environment (push)",
    );
    console.log("ios: Info.plist, Expo.plist and entitlements read");
  } else {
    problems.push("ios/AsiaDriveClub/Info.plist was not generated");
  }
} finally {
  rmSync(join(app, "android"), { recursive: true, force: true });
  rmSync(join(app, "ios"), { recursive: true, force: true });
  if (readFileSync(packageJson, "utf8") !== packageBefore) {
    writeFileSync(packageJson, packageBefore);
    console.log("package.json put back as it was (prebuild rewrites its scripts)");
  }
}

// 3. The packages against the SDK.
if (!args.includes("--no-doctor")) {
  const doctor = run("npx", ["--yes", "expo-doctor@1.21.6"]);
  // Expo publishes patch versions of SDK 57 all the time: a package one patch
  // behind is a reminder (`pnpm --filter mobile exec expo install --fix`
  // before a release), not a broken build — CI must not turn red because a
  // patch came out overnight. Any other finding (a minor or major version off
  // the SDK, a duplicate native module, a broken config) fails.
  const onlyPatches =
    doctor.status !== 0 &&
    /1 check failed/.test(doctor.out) &&
    /Patch version mismatches/.test(doctor.out);
  if (onlyPatches) {
    console.warn(
      "::warning::expo-doctor: some packages are a patch behind SDK 57 — run `pnpm --filter mobile exec expo install --fix` before the next release",
    );
  } else {
    expect(doctor.status === 0, "expo-doctor found problems (above)");
  }
}

if (problems.length > 0) {
  console.error(`\nThe native configuration is not ready:\n  - ${problems.join("\n  - ")}`);
  process.exitCode = 1;
} else {
  console.log(
    `\nThe native configuration is ready for EAS Build (${isWindows ? "android; ios is generated in CI" : "android and ios"}).`,
  );
}
