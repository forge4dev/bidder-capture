# Render + Neon deployment

This dashboard can run with either:

- local SQLite when `DATABASE_URL` is not set;
- Neon/Postgres when `DATABASE_URL` is set.

## Neon

1. Create a Neon project.
2. Create a database.
3. Copy the pooled Postgres connection string.
4. Use that value as `DATABASE_URL` in Render.

## Render

Create a new Web Service.

Recommended settings:

```txt
Build Command: npm install
Start Command: npm start
```

Environment variables:

```txt
DATABASE_URL=postgresql://...
SESSION_SECRET=<long random string>
SERVER_TIME_ZONE=America/Los_Angeles
HOST=0.0.0.0
```

Optional local-Postgres setting only:

```txt
DATABASE_SSL=false
```

Do not set `DATABASE_SSL=false` for Neon.

## One-time duplicate cleanup

Duplicate consolidation is separate from normal server startup so historical cleanup cannot delay the dashboard from accepting requests.

Run this once for each database after deploying a version that includes the deduplication migration:

```powershell
$env:DATABASE_URL="postgresql://..."
npm.cmd run migrate:dedupe
```

The migration reads records in batches, removes older duplicate submissions, preserves the newest record and any saved note, and records completion in `schema_migrations`. Running the command again safely reports that it has already completed.

## First login

The server creates this default user on startup:

```txt
User ID: admin
Password: 123456
```

After signing in, go to `Setting` and set the bidder password.

## Extension

In the extension Options page, use:

```txt
Dashboard Server URL: https://<your-render-service>.onrender.com
Master User ID: admin
BIDDER_PASSWORD: <the value configured in Setting>
```

Then click `Test Connection`.
