import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base works for GitHub Pages project URLs (/<repo>/), custom domains, and local previews
  base: './',
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
