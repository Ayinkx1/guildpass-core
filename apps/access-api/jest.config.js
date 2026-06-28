module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Ensure tests under apps/access-api/test are discovered
  roots: ['<rootDir>/test', '<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
};

