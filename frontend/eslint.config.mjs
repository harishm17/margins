import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'

export default defineConfig([
  ...nextVitals,
  {
    // New in eslint-plugin-react-hooks 7. They flag the existing fetch-in-an-effect
    // pattern in 13 components; warn until data loading moves to React Query or the
    // server, rather than rewrite those components in a dependency upgrade.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
  {
    // Server code logs errors through logServerError (src/lib/ops/log.ts), which keeps an error's message (it can
    // carry student text) out of the logs. Browser-only components under src/features and src/components may keep console.
    files: ['src/app/**/*.{ts,tsx}', 'src/server/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}', 'src/instrumentation.ts'],
    ignores: ['**/*.test.{ts,tsx}', 'src/lib/ops/log.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='console'][property.name=/^(error|warn)$/]",
          message: 'Use logServerError(label, error, { ids }) from @/lib/ops/log in server code.',
        },
        {
          selector: "CallExpression[callee.name='logServerError'][arguments.0.type!='Literal']",
          message: 'The first argument of logServerError must be a plain string literal: no template, no variable.',
        },
      ],
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'playwright-report/**',
    'test-results/**',
  ]),
])
