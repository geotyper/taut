import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', three: '3d.html' },
    },
  },
});
