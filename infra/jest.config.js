// Transformed with @swc/jest rather than ts-jest: ts-jest needs the JavaScript
// compiler API, which TypeScript 7 (the Go-based native compiler) does not
// expose. swc does its own TypeScript parsing and never loads tsc, so the
// repo stays on TS 7 throughout. Type checking is still done by `tsc --noEmit`
// via the typecheck script - swc only strips types.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: false },
          target: 'es2022',
        },
      },
    ],
  },
  collectCoverageFrom: ['lib/**/*.ts', 'bin/**/*.ts'],
  coverageThreshold: {
    global: { branches: 70, functions: 70, lines: 70, statements: 70 },
  },
};
