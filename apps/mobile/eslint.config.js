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
];
