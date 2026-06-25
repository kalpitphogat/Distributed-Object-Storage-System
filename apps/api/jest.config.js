/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
  moduleNameMapper: {
    '^@mini-s3/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts',
    '^@mini-s3/hash-ring$': '<rootDir>/../../packages/hash-ring/src/index.ts',
  },
};
