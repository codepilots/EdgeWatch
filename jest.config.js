// jest.config.js
'use strict';

/** @type {import('jest').Config} */
module.exports = {
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  // Use jsdom for tests that deal with DOM APIs
  projects: [
    {
      displayName: 'background',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/background.test.js'],
      setupFiles: ['<rootDir>/tests/setup.js'],
    },
    {
      displayName: 'content',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/tests/content.test.js', '<rootDir>/tests/content-main.test.js'],
      setupFiles: ['<rootDir>/tests/setup.js'],
    },
  ],
};
