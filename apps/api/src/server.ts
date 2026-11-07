import { apiPort, makeApi } from './app.js';
makeApi().listen(apiPort, '127.0.0.1', () =>
  console.info('SafeStep API: http://127.0.0.1:' + apiPort + '/health'),
);
