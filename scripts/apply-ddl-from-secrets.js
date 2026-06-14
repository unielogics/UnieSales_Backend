const fs = require('node:fs');
const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error('Usage: node apply-ddl-from-secrets.js <sql-file>...');

  const secrets = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const secret = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.AWS_SECRET_ID || 'uniesales/prod/app' }),
  );
  const parsed = JSON.parse(secret.SecretString || '{}');
  if (!parsed.DATABASE_URL) throw new Error('DATABASE_URL missing from secret');

  const client = new Client({
    connectionString: parsed.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(parsed.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    for (const file of files) {
      await client.query(fs.readFileSync(file, 'utf8'));
      console.log(`applied ${file}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
