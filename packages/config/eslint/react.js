const globals = require("globals");
const reactHooks = require("eslint-plugin-react-hooks");
const base = require("./base.js");

module.exports = [
  ...base,
  {
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
];
