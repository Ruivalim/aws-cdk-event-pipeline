// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['cdk.out/**', 'dist/**', 'node_modules/**', 'eslint.config.mjs', 'jest.config.js'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: {
        // Resolves each file against the nearest tsconfig, so no file is
        // silently excluded from type-aware linting.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The CDK's generated types are structural and often require assertions
      // when walking a template. Keep the rule on, but allow the escape hatch.
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
