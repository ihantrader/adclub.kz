// Lets the app's own Android build see whether WhatsApp or WhatsApp Business
// is installed (TASK-029.B, ARCHITECTURE 4.46, `src/orders/call-options.ts`):
// since Android 11 an app sees only the packages its manifest names in
// `<queries>`, and without them `Linking.canOpenURL("whatsapp://…")` is false
// even with WhatsApp on the phone. Expo Go has a manifest of its own and is
// not affected by this — there the app cannot know, and says so.
const { withAndroidManifest } = require("expo/config-plugins");

const PACKAGES = ["com.whatsapp", "com.whatsapp.w4b"];

module.exports = function withWhatsappQueries(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const queries = (manifest.queries ??= [{}])[0];
    const listed = (queries.package ??= []);
    for (const name of PACKAGES) {
      if (!listed.some((entry) => entry.$?.["android:name"] === name)) {
        listed.push({ $: { "android:name": name } });
      }
    }
    return mod;
  });
};
