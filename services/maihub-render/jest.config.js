/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { isolatedModules: true, module: 'CommonJS', target: 'ES2022', esModuleInterop: true, resolveJsonModule: true } }],
  },
  testMatch: ['<rootDir>/test/**/*.test.ts'],
};
