import { defineConfig } from 'vite';
export default defineConfig({ base: '/crm/', server: { proxy: { '/v1': 'http://127.0.0.1:8090', '/health': 'http://127.0.0.1:8090' } } });
