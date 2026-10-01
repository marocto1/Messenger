import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // External cache hydration and asynchronous resource loaders intentionally update state
  // from effects. React Compiler is not enabled; other hook correctness rules stay on.
  { rules: { 'react-hooks/set-state-in-effect': 'off' } },
  globalIgnores(['.next*/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);
