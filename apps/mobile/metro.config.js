const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Workspace packages (@adclub/*) expose their TypeScript sources under the
// "adclub-source" export condition (ARCHITECTURE 4.4). Metro bundles those
// directly: no prebuilt dist/ is needed to start the app, and edits in a
// shared package reload live. Node, Vite and tsc ignore the condition and
// keep using the compiled CommonJS in dist/.
config.resolver.unstable_conditionNames = [
  ...(config.resolver.unstable_conditionNames ?? []),
  "adclub-source",
];

module.exports = config;
