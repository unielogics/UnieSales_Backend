# UnieSales Backend

Production backend for UnieSales / AI Sales Operator OS. Multi-workspace AI outbound + nurture platform.

Stack: Node 20, TypeScript, Fastify, Drizzle ORM, PostgreSQL (RDS), S3, PM2.

## Local development

```bash
cp .env.example .env
# Fill DATABASE_URL with a Postgres you can reach
npm install
npm run dev
curl http://localhost:4000/health
```

## Production (EC2)

The EC2 instance role provides AWS credentials. Set `AWS_REGION` and `AWS_SECRET_ID` (defaults to `uniesales/prod/app`); env values are pulled from Secrets Manager at boot. `.env` is only used as fallback for missing keys.

```bash
npm install
npm run build
npm run migrate         # apply migrations to RDS
pm2 start ecosystem.config.cjs
pm2 save
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | tsx watch — restart on file change |
| `npm run build` | tsc → `dist/` |
| `npm run start` | run compiled output |
| `npm run typecheck` | tsc --noEmit |
| `npm run migrate` | apply Drizzle migrations to `DATABASE_URL` |
| `npm run migrate:generate` | generate new migration from schema diff |
| `npm test` | vitest run |

## Architecture

See `C:\Users\franc\.claude\plans\claude-backend-handoff-gleaming-moore.md` for the full plan.

Hard rule: **workspace_id isolation**. Every query that touches workspace-scoped data must filter by `workspace_id`. Middleware enforces membership; query helpers require it as a parameter.
