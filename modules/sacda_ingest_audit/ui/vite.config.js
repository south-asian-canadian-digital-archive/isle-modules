import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// One IIFE + one stylesheet into ../dist, referenced by
// sacda_ingest_audit.libraries.yml. Fixed names, no hashes: Drupal adds its
// own cache-busting query string.
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: 'src/main.js',
      name: 'SacdaIngestAudit',
      formats: ['iife'],
      fileName: () => 'ingest-audit.js',
      cssFileName: 'ingest-audit',
    },
  },
});
