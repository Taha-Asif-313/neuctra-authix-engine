/**
 * The whole engine over HTTP, then moving an app, against a real database.
 *
 * Needs an empty database that has been through `npm run setup`, named by
 * TEST_DATABASE_URL. DATABASE_URL is deliberately ignored, so this can never
 * run against a database someone is using.
 *
 *   TEST_DATABASE_URL=postgresql://... npm test
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const url = process.env.TEST_DATABASE_URL;

describe("engine", { skip: url ? false : "TEST_DATABASE_URL is not set" }, () => {
  const ORIGIN = "https://notes.example";
  let prisma, server, base, transfer, createApiKey;
  let owner, app, publishable, secret, cookie, user;

  const api = async (method, path, { key = publishable, body, origin = ORIGIN, sendCookie = true } = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        "x-api-key": key,
        ...(origin ? { origin } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(sendCookie && cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];

    return { status: res.status, body: await res.json() };
  };

  const issueKey = async (kind, appId) => {
    const key = createApiKey(kind);
    await prisma.apiKey.create({
      data: {
        adminId: owner.id,
        appId,
        kind,
        prefix: key.prefix,
        hash: key.hash,
        lastFour: key.lastFour,
      },
    });
    return key.plaintext;
  };

  const newApp = (name = "Notes") =>
    prisma.app.create({
      data: {
        applicationName: name,
        category: "other",
        description: "",
        platform: "web",
        allowedOrigins: [ORIGIN],
        adminId: owner.id,
      },
    });

  before(async () => {
    process.env.DATABASE_URL = url;
    process.env.USER_JWT_SECRET ||= randomBytes(32).toString("hex");
    process.env.NODE_ENV = "development";

    ({ default: prisma } = await import("../shared/prisma.js"));
    transfer = await import("../shared/utils/appTransfer.js");
    ({ createApiKey } = await import("../shared/utils/crypto.js"));
    const { default: expressApp } = await import("../app.js");

    owner = await prisma.adminUser.create({
      data: { name: "Test", email: `${randomBytes(6).toString("hex")}@test.local` },
    });
    app = await newApp();
    publishable = await issueKey("publishable", app.id);
    secret = await issueKey("secret", app.id);

    server = expressApp.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    await prisma?.$disconnect();
  });

  it("reports health", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
  });

  it("signs a user up and in", async () => {
    const signup = await api("POST", "/users/signup", {
      body: { name: "Ada", email: "Ada@Example.com", password: "correct-horse", appId: app.id },
    });
    assert.equal(signup.status, 201);
    user = signup.body.user;
    assert.equal(user.email, "ada@example.com");

    const short = await api("POST", "/users/signup", {
      body: { name: "Bo", email: "bo@example.com", password: "short", appId: app.id },
    });
    assert.equal(short.body.code, "PASSWORD_TOO_SHORT");

    // Records need a verified email. A code would only arrive by email here.
    await prisma.user.update({ where: { id: user.id }, data: { isVerified: true } });

    const login = await api("POST", "/users/login", {
      body: { email: "ada@example.com", password: "correct-horse", appId: app.id },
    });
    assert.equal(login.status, 200);
    assert.ok(cookie);

    const session = await api("GET", "/users/session");
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.user.isVerified, true);
  });

  it("refuses origins the app does not allow", async () => {
    const res = await api("POST", "/users/login", {
      origin: "https://evil.example",
      body: { email: "ada@example.com", password: "correct-horse", appId: app.id },
    });
    assert.equal(res.status, 403);
  });

  it("stores, reads and searches records", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await api("POST", `/users/${user.id}/data`, {
        body: { dataCategory: "Notes", title: `Note ${i}`, status: i % 2 ? "done" : "open", tags: ["work"] },
      });
      assert.equal(res.status, 201);
    }

    const list = await api("GET", `/users/${user.id}/data?category=notes`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 5);

    const byKey = await api("POST", `/users/${user.id}/data/search`, {
      body: { keys: { status: "done" } },
    });
    assert.equal(byKey.status, 200);
    assert.equal(byKey.body.data.length, 2);

    const byNested = await api("POST", `/users/${user.id}/data/search`, {
      body: { keys: { tags: ["work"] } },
    });
    assert.equal(byNested.body.data.length, 5);

    const byText = await api("POST", `/users/${user.id}/data/search`, { body: { q: "NOTE 3" } });
    assert.equal(byText.body.data.length, 1);
    assert.equal(byText.body.data[0].title, "Note 3");
  });

  it("pages through a search without repeats", async () => {
    const seen = [];
    let cursor;

    do {
      const res = await api("POST", `/users/${user.id}/data/search`, {
        body: { category: "notes", limit: 2, cursor },
      });
      assert.equal(res.status, 200);
      seen.push(...res.body.data.map((row) => row.id));
      cursor = res.body.nextCursor;
      assert.ok(seen.length <= 5, "a page repeated");
    } while (cursor);

    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5);
  });

  it("updates with optimistic concurrency", async () => {
    const [item] = (await api("GET", `/users/${user.id}/data`)).body.data;

    const first = await api("PUT", `/users/${user.id}/data/${item.id}`, {
      body: { title: "Edited", version: item.version },
    });
    assert.equal(first.status, 200);

    const stale = await api("PUT", `/users/${user.id}/data/${item.id}`, {
      body: { title: "Stale", version: item.version },
    });
    assert.equal(stale.status, 409);
  });

  it("serves app data and cross-user search to a secret key only", async () => {
    const write = await api("POST", `/app/${app.id}/data/config`, {
      key: secret,
      origin: null,
      sendCookie: false,
      body: { theme: "dark" },
    });
    // The app has an origin list, so a server needs its IP or an Origin header.
    assert.equal(write.status, 403);

    await prisma.app.update({
      where: { id: app.id },
      data: { allowedIps: ["127.0.0.1", "::1", "::ffff:127.0.0.1"] },
    });

    const allowed = await api("POST", `/app/${app.id}/data/config`, {
      key: secret,
      origin: null,
      sendCookie: false,
      body: { theme: "dark" },
    });
    assert.equal(allowed.status, 201);

    const read = await api("GET", `/app/${app.id}/app-data`);
    assert.equal(read.status, 200);
    assert.equal(read.body.data.length, 1);

    const blocked = await api("POST", `/app/${app.id}/data/config`, { body: { theme: "x" } });
    assert.equal(blocked.status, 403);

    const search = await api("POST", `/app/global/${app.id}/all-app-users/search`, {
      key: secret,
      origin: null,
      sendCookie: false,
      body: { q: "ADA" },
    });
    assert.equal(search.status, 200);
    assert.equal(search.body.data.length, 1);

    const dataSearch = await api("POST", `/app/global/${app.id}/all-app-users-data/search`, {
      key: secret,
      origin: null,
      sendCookie: false,
      body: { keys: { status: "done" } },
    });
    assert.equal(dataSearch.status, 200);
    assert.equal(dataSearch.body.data.length, 2);
  });

  it("ends the session on logout", async () => {
    const stolen = cookie;
    await api("POST", "/users/logout");
    cookie = stolen;

    const session = await api("GET", "/users/session");
    assert.equal(session.body.authenticated, false);
  });

  /* ---------- moving an app ---------- */

  const readAll = async (appId) => {
    const rows = {};
    for (const kind of [transfer.KINDS.USERS, transfer.KINDS.USER_DATA, transfer.KINDS.APP_DATA]) {
      rows[kind] = [];
      let cursor = null;
      do {
        const page = await transfer.readPage(prisma, kind, appId, cursor);
        rows[kind].push(...page.rows);
        cursor = page.nextCursor;
      } while (cursor);
    }
    return JSON.parse(JSON.stringify(rows));
  };

  const limits = { maxUsersPerApp: Infinity, maxUserDataPerUser: Infinity, maxAppDataStorage: Infinity };
  const write = (kind, rows, appId, overrides = {}) =>
    transfer.writeBatch(prisma, kind, rows, { appId, adminId: owner.id, limits, ...overrides });

  const deleteApp = async (appId) => {
    await prisma.userDataItem.deleteMany({ where: { appId } });
    await prisma.appDataItem.deleteMany({ where: { appId } });
    await prisma.user.deleteMany({ where: { appId } });
    await prisma.app.delete({ where: { id: appId } });
  };

  it("restores an app exactly, passwords and parent links included", async () => {
    const [parent, child] = await prisma.userDataItem.findMany({ where: { appId: app.id }, take: 2 });
    await prisma.userDataItem.update({ where: { id: child.id }, data: { parentId: parent.id } });

    const before = await readAll(app.id);
    const links = before["user-data"].filter((row) => row.parentId);
    assert.equal(links.length, 1);
    const stored = await prisma.app.findUnique({ where: { id: app.id } });

    await deleteApp(app.id);

    const restored = await prisma.app.create({
      data: { id: app.id, applicationName: "Notes", category: "other", description: "", platform: "web", adminId: owner.id, isActive: false, allowedOrigins: [ORIGIN] },
    });

    // Sent with the children first and in small pieces, as a real upload can be.
    await write("user", before.user, restored.id);
    await write("user-data", [...before["user-data"]].reverse(), restored.id);
    await write("app-data", before["app-data"], restored.id);
    await write("user-data-link", links, restored.id);
    await prisma.app.update({ where: { id: app.id }, data: { isActive: true } });

    assert.deepEqual(await readAll(app.id), before);

    const after = await prisma.app.findUnique({ where: { id: app.id } });
    assert.equal(after.userDataStorageUsed, stored.userDataStorageUsed);
    assert.equal(after.appDataStorageUsed, stored.appDataStorageUsed);

    cookie = null;
    const login = await api("POST", "/users/login", {
      body: { email: "ada@example.com", password: "correct-horse", appId: app.id },
    });
    assert.equal(login.status, 200, "the same password still signs in");
  });

  it("can repeat a batch after a dropped connection without doubling", async () => {
    const rows = await readAll(app.id);
    const before = await prisma.app.findUnique({ where: { id: app.id } });

    assert.equal(await write("user-data", rows["user-data"], app.id), 0);

    const after = await prisma.app.findUnique({ where: { id: app.id } });
    assert.equal(after.userDataStorageUsed, before.userDataStorageUsed);
  });

  it("refuses to take a row that belongs to another app", async () => {
    const target = await newApp("Other");
    const rows = await readAll(app.id);

    await assert.rejects(write("user", rows.user, target.id), { code: "ID_CONFLICT" });

    const untouched = await prisma.user.findUnique({ where: { id: rows.user[0].id } });
    assert.equal(untouched.appId, app.id);
    await deleteApp(target.id);
  });

  it("refuses records owned by a user from another app", async () => {
    const target = await newApp("Other");
    const [row] = (await readAll(app.id))["user-data"];

    await assert.rejects(
      write("user-data", [{ ...row, id: "fresh_record_id" }], target.id),
      { code: "INVALID_BUNDLE" },
    );
    await deleteApp(target.id);
  });

  it("refuses to link a record to a parent in another app", async () => {
    const target = await newApp("Other");
    const [source] = (await readAll(app.id))["user-data"];
    const hash = `$2b$12$${"a".repeat(53)}`;
    const now = new Date().toISOString();

    await write("user", [{ id: "other_user", email: "o@o.co", name: "O", password: hash, createdAt: now, updatedAt: now }], target.id);
    await write("user-data", [{ id: "other_item", userId: "other_user", dataCategory: "x", payload: {}, createdAt: now, updatedAt: now }], target.id);

    await assert.rejects(
      write("user-data-link", [{ id: "other_item", parentId: source.id }], target.id),
      { code: "INVALID_BUNDLE" },
    );
    await deleteApp(target.id);
  });

  it("ignores ownership and sizes claimed by a bundle", async () => {
    const target = await newApp("Other");
    const hash = `$2b$12$${"a".repeat(53)}`;
    const now = new Date().toISOString();

    await write("user", [{ id: "claim_user", email: "c@c.co", name: "C", password: hash, createdAt: now, updatedAt: now, appId: app.id, adminId: "someone", role: "owner" }], target.id);
    await write("user-data", [{ id: "claim_item", userId: "claim_user", dataCategory: "x", payload: { a: 1 }, sizeBytes: 1, searchText: "fake", appId: app.id, createdAt: now, updatedAt: now }], target.id);

    const row = await prisma.user.findUnique({ where: { id: "claim_user" } });
    assert.equal(row.appId, target.id);
    assert.equal(row.adminId, owner.id);

    const item = await prisma.userDataItem.findUnique({ where: { id: "claim_item" } });
    assert.equal(item.appId, target.id);
    assert.equal(item.sizeBytes, 7);
    assert.notEqual(item.searchText, "fake");
    await deleteApp(target.id);
  });

  it("refuses a plain-text password, which could never sign in", async () => {
    const now = new Date().toISOString();
    await assert.rejects(
      write("user", [{ id: "plain", email: "p@p.co", name: "P", password: "hunter2", createdAt: now, updatedAt: now }], app.id),
      { code: "INVALID_BUNDLE" },
    );
  });

  it("enforces limits passed in by the host", async () => {
    const target = await newApp("Limited");
    const hash = `$2b$12$${"a".repeat(53)}`;
    const now = new Date().toISOString();
    const row = (n) => ({ id: `lim_${n}`, email: `${n}@l.co`, name: "L", password: hash, createdAt: now, updatedAt: now });

    await assert.rejects(
      write("user", [row(1), row(2)], target.id, { limits: { ...limits, maxUsersPerApp: 1 } }),
      { code: "MAX_USERS_PER_APP_REACHED" },
    );
    assert.equal(await prisma.user.count({ where: { appId: target.id } }), 0);
    await deleteApp(target.id);
  });

  it("detects a file that was cut short", async () => {
    const counts = await transfer.countApp(prisma, app.id);
    assert.throws(
      () => transfer.assertCounts(counts, { ...counts, user: counts.user + 1 }),
      { code: "INCOMPLETE_IMPORT" },
    );
  });
});
