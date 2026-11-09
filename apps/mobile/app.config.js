// The app's configuration is `app.json`; this file only adds what lives
// outside the repository (TASK-056, ARCHITECTURE 4.81):
//
// - `extra.eas.projectId` — written into app.json by `eas init` (or by hand)
//   once the Product Owner's Expo project exists; the address of EAS Update
//   (`updates.url`) is made from it. Without it the build has no OTA source
//   and `expo-updates` stays silent — the app runs on the code it shipped with.
// - `android.googleServicesFile` — `google-services.json` of the Firebase
//   project (Android push). It is never in git: EAS keeps it as the file
//   environment variable `GOOGLE_SERVICES_JSON`, whose value on a build
//   server is the path of the file.
module.exports = ({ config }) => {
  const projectId = config.extra?.eas?.projectId ?? process.env.EAS_PROJECT_ID;
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;
  return {
    ...config,
    ...(projectId
      ? {
          extra: { ...config.extra, eas: { ...config.extra?.eas, projectId } },
          updates: { ...config.updates, url: `https://u.expo.dev/${projectId}` },
        }
      : {}),
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  };
};
