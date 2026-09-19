import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Kernel packages are consumed straight from source in dev and build: there
    // is no compile step between a package and the app, so a kernel change is
    // visible immediately and typechecking covers both at once.
    alias: {
      '@helm/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@helm/ontology': fileURLToPath(new URL('./packages/ontology/src/index.ts', import.meta.url)),
      '@helm/graph-store/postgres': fileURLToPath(new URL('./packages/graph-store/src/postgres.ts', import.meta.url)),
      '@helm/graph-store': fileURLToPath(new URL('./packages/graph-store/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5183,
  },
  build: {
    rollupOptions: {
      output: {
        // Same grouping rationale as Memoire: per-icon chunks defer nothing
        // and cost a request each; only genuinely shared vendor code groups.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('@supabase')) return 'supabase';
          if (id.includes('react-router')) return 'router';
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
});
