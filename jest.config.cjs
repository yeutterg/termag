// Jest configuration for termag-next
// Simple configuration focused on testing utility functions

const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.cjs'],
  testEnvironment: 'node',
  roots: ['<rootDir>/apps/web/lib', '<rootDir>/apps/agent/src'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/apps/web/$1',
    '^@termag/web/(.*)$': '<rootDir>/apps/web/$1',
  },
  collectCoverageFrom: [
    'apps/web/lib/**/*.{js,jsx,ts,tsx}',
    'apps/agent/src/**/*.{js,jsx,ts,tsx}',
    '!**/*.d.ts',
    '!**/*.config.{js,ts}',
    '!**/node_modules/**',
    '!**/.next/**',
    '!**/dist/**',
  ],
  testMatch: [
    '**/__tests__/**/*.[jt]s?(x)',
    '**/?(*.)+(spec|test).[jt]s?(x)',
  ],
  testPathIgnorePatterns: [
    '<rootDir>/.next/',
    '<rootDir>/node_modules/',
    '<rootDir>/apps/web/.next/',
    '<rootDir>/apps/agent/dist/',
  ],
  preset: 'ts-jest',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        jsx: 'react',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      },
    }],
  },
}

module.exports = customJestConfig