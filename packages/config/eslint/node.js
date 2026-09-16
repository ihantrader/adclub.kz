const globals = require("globals");
const base = require("./base.js");

module.exports = [
  ...base,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
];
