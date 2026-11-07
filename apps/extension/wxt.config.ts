import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: { disabled: true }, // Dev mode watches locally; load its unpacked directory in the browser you choose.
  manifest: {
    name: 'SafeStep',
    description: 'Follow citation and VLC guides one click at a time, and check website and link addresses locally.',
    minimum_chrome_version: '120',
    permissions: ['activeTab', 'scripting', 'sidePanel', 'storage'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    // Chrome match patterns do not distinguish ports. Only the fixed health URL is called.
    host_permissions: ['http://127.0.0.1/*'],
    action: { default_title: 'Open SafeStep' },
    side_panel: { default_path: 'sidepanel.html' },
  },
});
