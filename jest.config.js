/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  preset: 'ts-jest', // Sử dụng preset của ts-jest
  testEnvironment: 'node', // Môi trường chạy test là Node.js
  transform: {
    // isolatedModules: mỗi file chỉ được chuyển mã, không type-check. Nếu để ts-jest
    // type-check thì mỗi worker dựng lại chương trình TypeScript của cả dự án (vài GB
    // RAM mỗi worker) và `npm test` làm treo máy. Type-check do `tsc --noEmit` đảm nhận.
    "^.+\\.tsx?$": ["ts-jest", {
      tsconfig: { isolatedModules: true, module: 'CommonJS', target: 'ES2020', esModuleInterop: true, resolveJsonModule: true },
    }],
  },
  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'], // Đường dẫn đến các tệp test
};
