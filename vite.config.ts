import { defineConfig } from 'vite';

export default defineConfig({
  // Relative, so the build runs from any folder, such as geotyper.github.io/taut/.
  base: './',
  build: {
    rollupOptions: {
      input: { main: 'index.html', three: '3d.html', clusters: 'clusters.html', foam: 'foam.html', foam3d: 'foam3d.html', wire: 'wire.html', cells: 'cells.html' },
    },
  },
});
