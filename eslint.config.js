// eslint.config.js – ESLint 9+ flat configuration
'use strict';

const js      = require('@eslint/js');
const globals = require('globals');

/** Browser extension source files share browser + chrome extension globals. */
const extensionGlobals = {
  ...globals.browser,
  chrome: 'readonly',
};

module.exports = [
  // Ignore build output and dependencies
  {
    ignores: ['dist/**', 'node_modules/**'],
  },

  // Extension source scripts
  {
    files: ['background.js', 'content.js', 'content-main.js', 'popup.js', 'options.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: extensionGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-console': 'off', // Console interception is intentional
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'all'],
    },
  },

  // Jest test files
  {
    files: ['tests/**/*.test.js', 'tests/setup.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
        ...extensionGlobals,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // Build script
  {
    files: ['build.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: js.configs.recommended.rules,
  },
];
