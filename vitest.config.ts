import { defineConfig } from 'vitest/config';

// tsconfig keeps "jsx": "preserve" (Next's requirement), which makes the
// oxc transform pass JSX through untouched. Tests render real components,
// so flip the JSX transform on for the test pipeline only.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
});
