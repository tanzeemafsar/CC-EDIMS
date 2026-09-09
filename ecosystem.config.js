// =============================================================================
// EDIMS — ecosystem.config.js
// PM2 process manager configuration
//
// Usage:
//   npm install -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup
//   pm2 logs edims | pm2 monit
// =============================================================================

module.exports = {
  apps: [
    {
      name:        'edims',
      script:      './server.js',
      cwd:         __dirname,
      instances:   1,
      exec_mode:   'fork',
      autorestart:     true,
      max_restarts:    10,
      restart_delay:   4000,
      max_memory_restart: '400M',
      env_file: './.env',
      env: { NODE_ENV: 'production' },
      env_development: { NODE_ENV: 'development', PORT: '3000' },
      out_file:        './logs/edims-out.log',
      error_file:      './logs/edims-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs:      true,
      kill_timeout:    15000,
      listen_timeout:  8000,
      watch:      false,
      ignore_watch: ['node_modules', 'public/images', 'logs', 'certs', '.git'],
    },
  ],
};
