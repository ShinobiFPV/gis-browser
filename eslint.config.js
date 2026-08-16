import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // The flat config itself is not part of either tsconfig project, so it gets the
  // untyped ruleset rather than tripping the type-aware project service.
  // The flat config and the standalone maintenance scripts are not part of either
  // tsconfig project, so they get the untyped ruleset rather than tripping the
  // type-aware project service.
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'eslint.config.js', 'scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // A swallowed fetch failure is the worst bug class in this app.
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': 'off',
    },
  },
  prettier,
);
