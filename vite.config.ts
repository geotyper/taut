import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', three: '3d.html', clusters: 'clusters.html', foam: 'foam.html', foam3d: 'foam3d.html', wire: 'wire.html' },
    },
  },
});
