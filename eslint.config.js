// Lint for bugs, not style.
//
// This codebase grew without a linter, so the rules here are chosen to catch
// things that are actually wrong (an undefined variable, a hook called
// conditionally, a list rendered without keys, a duplicated object key) rather
// than to enforce a formatting opinion across 45,000 existing lines. Style rules
// would mean either a giant reformatting commit, which buries the git history
// that the code's comments rely on, or thousands of warnings nobody reads.
//
// `npm run lint` fails on errors only. Warnings are shown but don't fail CI:
// they mark things worth a look (an unused variable, a hook dependency list that
// may be stale) without blocking a change over code nobody touched.
import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  { ignores: ["dist/**", "node_modules/**", ".wrangler/**", "bookmarklet.txt"] },

  // The website. Several .js files contain JSX, so JSX is enabled for both.
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      ...js.configs.recommended.rules,
      "react/jsx-key": "error",
      "react/jsx-no-undef": "error",
      "react/jsx-uses-vars": "error",
      "react/no-direct-mutation-state": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": ["warn", { args: "none", ignoreRestSiblings: true, caughtErrors: "none" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // Escaped characters that didn't need escaping. Harmless, so not a
      // reason to fail a build.
      "no-useless-escape": "warn",
      // Escapes like \u200D are the readable way to write invisible characters.
      "no-misleading-character-class": ["error", { allowEscape: true }],
    },
  },

  // The Cloudflare Worker.
  {
    files: ["worker/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.serviceworker, AbortSignal: "readonly" },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-useless-escape": "warn",
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },

  // Tests and tooling run in Node. `check` is the assertion the test runner
  // installs globally (tests/run.mjs).
  {
    files: ["tests/**/*.mjs", "*.config.js", "scripts/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, check: "readonly" },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
    },
  },

  // Runs on the company timesheet page, which provides jQuery and its own
  // row helpers as page globals.
  {
    files: ["bookmarklet.src.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        $: "readonly", jQuery: "readonly",
        RowAdd: "readonly", populateJobInfo: "readonly", timesheetRowUpdateCheck: "readonly",
      },
    },
    rules: { ...js.configs.recommended.rules },
  },
];
