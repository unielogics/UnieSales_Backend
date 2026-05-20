// PM2 process map. Workers come online in Phase 11; commented out for Phase 0.
module.exports = {
  apps: [
    {
      name: 'uniesales-api',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      out_file: '/opt/uniesales/logs/api.out.log',
      error_file: '/opt/uniesales/logs/api.err.log',
      merge_logs: true,
      time: true,
    },
    // {
    //   name: 'gmail-worker',
    //   script: './dist/workers/gmail.worker.js',
    //   instances: 1,
    //   env: { NODE_ENV: 'production' },
    // },
    // {
    //   name: 'ai-worker',
    //   script: './dist/workers/ai.worker.js',
    //   instances: 1,
    //   env: { NODE_ENV: 'production' },
    // },
    // {
    //   name: 'followup-worker',
    //   script: './dist/workers/followup.worker.js',
    //   instances: 1,
    //   env: { NODE_ENV: 'production' },
    // },
    {
      name: 'knowledge-worker',
      script: './dist/workers/knowledge.worker.js',
      instances: 1,
      env: { NODE_ENV: 'production' },
      out_file: '/opt/uniesales/logs/knowledge-worker.out.log',
      error_file: '/opt/uniesales/logs/knowledge-worker.err.log',
      merge_logs: true,
      time: true,
    },
    // {
    //   name: 'domain-health-worker',
    //   script: './dist/workers/domain-health.worker.js',
    //   instances: 1,
    //   env: { NODE_ENV: 'production' },
    // },
  ],
};
