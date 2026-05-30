// PM2 process map: api + 5 workers.
const workerLog = (name) => ({
  out_file: `/opt/uniesales/logs/${name}.out.log`,
  error_file: `/opt/uniesales/logs/${name}.err.log`,
  merge_logs: true,
  time: true,
});

module.exports = {
  apps: [
    {
      name: 'uniesales-api',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      env: { NODE_ENV: 'production' },
      ...workerLog('api'),
    },
    {
      name: 'knowledge-worker',
      script: './dist/workers/knowledge.worker.js',
      instances: 1,
      env: { NODE_ENV: 'production' },
      ...workerLog('knowledge-worker'),
    },
    {
      name: 'gmail-worker',
      script: './dist/workers/gmail.worker.js',
      instances: 1,
      env: { NODE_ENV: 'production' },
      ...workerLog('gmail-worker'),
    },
    {
      name: 'ai-worker',
      script: './dist/workers/ai.worker.js',
      instances: 1,
      env: { NODE_ENV: 'production' },
      ...workerLog('ai-worker'),
    },
    {
      name: 'followup-worker',
      script: './dist/workers/followup.worker.js',
      instances: 1,
      env: { NODE_ENV: 'production' },
      ...workerLog('followup-worker'),
    },
    {
      name: 'domain-health-worker',
      script: './dist/workers/domain-health.worker.js',
      instances: 1,
      env: { NODE_ENV: 'production' },
      ...workerLog('domain-health-worker'),
    },
    {
      name: 'lead-source-worker',
      script: './dist/workers/lead-source.worker.js',
      instances: 1,
      env: { NODE_ENV: 'production' },
      ...workerLog('lead-source-worker'),
    },
  ],
};
