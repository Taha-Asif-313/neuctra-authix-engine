# Neuctra Authix Engine

Authentication and user data for your app, running on your own server and your
own PostgreSQL or MySQL database.

The engine has the same API as the hosted
[Neuctra Authix](https://authix.neuctra.com) service, so the Authix SDKs work with
it unchanged. Your app can move between the two in either direction, and your
users keep their accounts and passwords.

## Quick start

You need Node.js 20 or later and a PostgreSQL or MySQL 8 database.

```bash
npm install
npm run setup     # creates .env, then stops so you can set DATABASE_URL
npm run setup     # creates the tables, your first app and its API keys
npm start
```

To name the first app and allow your frontend's address:

```bash
npm run setup -- --app "Notes" --origin http://localhost:3000
```

Setup prints your `appId` and two API keys. Copy the keys straight away, because
they are stored hashed and cannot be shown again. Then point an SDK at the engine:

```js
import { NeuctraAuthix } from "@neuctra/authix";

const authix = new NeuctraAuthix({
  baseUrl: "http://localhost:5000/api",
  apiKey: process.env.AUTHIX_PUBLISHABLE_KEY,
  appId: process.env.AUTHIX_APP_ID,
});
```

In development you don't need a mail server: verification and password reset
codes are printed in the engine's terminal.

## Connecting your database

Set `DATABASE_URL` in `.env`.

```bash
# PostgreSQL: keep ?schema=authix
DATABASE_URL=postgresql://user:password@localhost:5432/mydb?schema=authix

# MySQL 8 or later: use a database of its own
DATABASE_URL=mysql://user:password@localhost:3306/authix
```

Setup only ever adds Authix's own tables. If the place you point it at already
contains tables, it stops without changing anything. Using `?schema=authix` lets
Authix share a PostgreSQL database with your own tables without touching them.

## Moving your app

A move uses a single `.authix` file containing the app, its users and all their
records.

**That file contains password hashes and all your users' data.** Treat it like a
database backup, and delete it when you are done.

### From your engine to Neuctra Authix cloud

1. Export the app:

   ```bash
   npm run authix -- export --out notes.authix
   ```

2. In the [dashboard](https://authix.neuctra.com/dashboard), go to **Apps** and
   choose **Import app**, then select the file.
3. Update your app's configuration. The `appId` stays the same unless the dashboard
   tells you otherwise:

   ```js
   baseUrl: "https://server.authix.neuctra.com/api",
   apiKey: "<your key from the API Keys page>",
   ```

4. Add your live website to the app's allowed origins in its **Access** settings,
   then deploy.

### From Neuctra Authix cloud to your engine

1. In the dashboard, open the app and choose **Export for self-hosting**.
2. Load the file. This prints new API keys for your engine:

   ```bash
   npm run authix -- import authix-<appId>.authix
   ```

3. Update `baseUrl` and your keys, then add your site with `origin:add`.

### What moves and what doesn't

| Moves | Doesn't move |
| --- | --- |
| The app and its allowed origins and IPs | API keys: each side issues its own |
| Users, roles and verified status | Active sessions: users sign in again |
| Password hashes: passwords keep working | Unfinished email codes |
| All records, their ids and parent links | Usage history |

An import always creates a new app. It can't merge into or overwrite an existing
one, so importing the same app twice is refused. On the cloud, your plan's limits
apply to what you import.

## Commands

Run these as `npm run authix -- <command>`.

| Command | What it does |
| --- | --- |
| `app:list` | List apps |
| `app:create "Notes" [--origin <url>]` | Create an app and its keys |
| `origin:add <url> [--app <id>]` | Allow a website to use an app |
| `key:create secret\|publishable [--app <id>]` | Create an API key |
| `key:revoke <key or prefix>` | Revoke an API key |
| `export [--app <id>] [--out <file>]` | Save an app to a bundle file |
| `import <file>` | Load a bundle file |

Use `--app <id>` when the engine has more than one app.

## Going to production

- Set `NODE_ENV=production`, and serve the engine over HTTPS. Session cookies
  require it.
- Set the `SMTP_*` variables. In production, email codes are never printed, and
  without SMTP users can't verify their email or reset a password.
- Allow your site with `npm run authix -- origin:add https://yoursite.com`. A
  publishable key won't work from a browser until its site is allowed.
- Behind a reverse proxy, set `TRUST_PROXY_HOPS` to the number of proxies. Leave it
  unset otherwise, because a wrong value lets clients forge their IP address.
- Keep `USER_JWT_SECRET` safe and unchanged. Changing it signs every user out.
- Rate limits are kept in memory, so they apply per process. If you run several
  copies of the engine, the effective limit is multiplied.
- Back up your database. Self-hosting means your data is your responsibility.
- `GET /health` reports whether the engine can reach the database.

If your site is on a different domain from the engine, sessions rely on
cross-site cookies, which Safari blocks. Serve the engine from a subdomain of your
site, such as `auth.yoursite.com`.

## How it differs from the cloud

| | Engine | Cloud |
| --- | --- | --- |
| SDK API | Same | Same |
| Manage apps with | Command line | Dashboard |
| Plan limits and quotas | None | By plan |
| Database | Your PostgreSQL or MySQL | Managed |
| Backups, updates, uptime | Yours | Managed |

## Database differences

Everything works on both. On PostgreSQL, setup also creates search indexes, which
need the `pg_trgm` extension. If your database user can't create it, setup warns and
search still works, but more slowly. MySQL has no equivalent indexes, so text search
and search by field scan the app's or user's records, and slow down as data grows.

## Tests

`npm test` needs an empty database that has been through `npm run setup`:

```bash
TEST_DATABASE_URL=postgresql://... npm test
```

`DATABASE_URL` is ignored on purpose, so the tests can't run against a database in
use. Without `TEST_DATABASE_URL`, they are skipped.

## Maintaining

`shared/utils/appTransfer.js` defines the bundle format, and must stay identical to
the copy in the hosted server, so that a file from one always loads in the other.
Changes to `prisma/postgresql/schema.prisma` must also be made in
`prisma/mysql/schema.prisma`, with a migration for each.

## License

[MIT](LICENSE)
