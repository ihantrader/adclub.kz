const base = require("@adclub/config/eslint/react.js");

module.exports = [
  ...base,
  {
    ignores: [".expo/**", "android/**", "ios/**", "dist/**", "web-build/**"],
  },
  {
    languageOptions: {
      globals: {
        __DEV__: "readonly",
      },
    },
  },
  {
    // Metro loads its config, and Expo its config plugins, as CommonJS Node modules.
    files: ["metro.config.js", "plugins/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", __dirname: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
