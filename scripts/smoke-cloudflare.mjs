import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This uses an isolated local preview account and never calls a model provider.
const origin = process.env.ARENA_SMOKE_ORIGIN || "http://127.0.0.1:5093";
const target = new URL(origin);
if (
  target.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(target.hostname)
)
  throw new Error("Smoke tests must target local development.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const local = resolve(root, ".wrangler/cloudflare-dev");
const runnerConfig = resolve(local, "runner/wrangler.json");
assert.equal(
  JSON.parse(readFileSync(runnerConfig, "utf8")).name,
  "decision-arena-local-runner",
  "Use the isolated dev:cloudflare configuration",
);
let cookie = "";
async function request(path, body, options = {}) {
  const response = await fetch(origin + path, {
    method: options.method || (body === undefined ? "GET" : "POST"),
    headers: {
      Origin: origin,
      Cookie: options.cookie ?? cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.headers.get("content-type")?.includes("application/json")) {
    const detail = (await response.text())
      .slice(0, 400)
      .replace(/sk-[\w-]+/g, "[redacted]");
    assert.fail(
      `${path}: expected JSON, received HTTP ${response.status}: ${detail}`,
    );
  }
  const payload = await response.json();
  if (options.status !== undefined)
    assert.equal(response.status, options.status, path);
  else
    assert.ok(
      response.ok,
      `${path}: ${response.status} ${payload.message || payload.error || ""}`,
    );
  return { response, payload: payload.data ?? payload };
}
async function account(label) {
  const email = `cf-smoke-${label}-${randomUUID()}@example.invalid`;
  const result = await request(
    "/api/auth/sign-up/email",
    {
      email,
      password: randomBytes(24).toString("base64url"),
      name: `Cloudflare smoke ${label}`,
    },
    { cookie: "" },
  );
  const cookies = result.response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  assert.ok(
    cookies.includes("session_token"),
    "Sign up must issue a session cookie",
  );
  assert.match(result.payload.user.id, /^[a-zA-Z0-9_-]+$/);
  return { cookie: cookies, userId: result.payload.user.id, email };
}

// Only the isolated smoke database is eligible for fixture role assignment.
function localSql(statement) {
  const path = resolve(local, `smoke-${randomUUID()}.sql`);
  writeFileSync(path, statement, { mode: 0o600 });
  try {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "decision-arena-db",
        "--local",
        "--config",
        runnerConfig,
        "--persist-to",
        resolve(local, "state"),
        "--file",
        path,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          WRANGLER_LOG_PATH: resolve(local, "logs"),
          WRANGLER_SEND_METRICS: "false",
        },
        encoding: "utf8",
        timeout: 60000,
      },
    );
    assert.equal(
      result.status,
      0,
      `Local fixture RBAC update failed: ${result.stderr || result.error || ""}`,
    );
  } finally {
    rmSync(path, { force: true });
  }
}
function grantFixtureModerator(account) {
  assert.match(account.userId, /^[a-zA-Z0-9_-]+$/);
  assert.match(
    account.email,
    /^cf-smoke-moderator-[a-f0-9-]+@example\.invalid$/,
  );
  const roleId = `smoke-role-${randomUUID()}`;
  localSql(`
    INSERT INTO role(id,name,title,status) VALUES('${roleId}','${roleId}','Smoke content moderator','active');
    INSERT INTO permission(id,code,resource,action,title)
      VALUES('smoke-content-permission','admin.posts.write','posts','write','Moderate community')
      ON CONFLICT(code) DO NOTHING;
    INSERT INTO role_permission(id,role_id,permission_id)
      SELECT '${randomUUID()}','${roleId}',id FROM permission WHERE code='admin.posts.write';
    INSERT INTO user_role(id,user_id,role_id)
      SELECT '${randomUUID()}',id,'${roleId}' FROM user WHERE id='${account.userId}' AND email='${account.email}';
  `);
  return roleId;
}
function openSocket(path) {
  const snapshots = [];
  let resolveFirst, rejectFirst, socket;
  const first = new Promise((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  const timeout = setTimeout(
    () => rejectFirst(new Error("WebSocket snapshot timed out")),
    15000,
  );
  const req = http.request(new URL(path, origin), {
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      Origin: origin,
      Cookie: cookie,
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      "Sec-WebSocket-Version": "13",
    },
  });
  req.on("response", (response) => {
    clearTimeout(timeout);
    response.resume();
    rejectFirst(new Error(`WebSocket returned ${response.statusCode}`));
  });
  req.on("error", rejectFirst);
  req.on("upgrade", (response, upgraded, head) => {
    assert.equal(response.statusCode, 101);
    socket = upgraded;
    let buffered = Buffer.alloc(0);
    function receive(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        let length = buffered[1] & 127,
          offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127) {
          if (buffered.length < 10) return;
          length = Number(buffered.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffered.length < offset + length) return;
        const opcode = buffered[0] & 15;
        const payload = buffered.subarray(offset, offset + length);
        buffered = buffered.subarray(offset + length);
        if (opcode === 1) {
          const message = JSON.parse(payload.toString());
          if (message.type === "snapshot") {
            snapshots.push(message.snapshot);
            clearTimeout(timeout);
            resolveFirst(message.snapshot);
          }
        }
      }
    }
    socket.on("data", receive);
    socket.on("error", rejectFirst);
    if (head.length) receive(head);
  });
  req.end();
  return {
    first,
    snapshots,
    close: () => {
      clearTimeout(timeout);
      socket?.destroy();
      req.destroy();
    },
  };
}

await request("/api/arena/models", undefined, { status: 401 });
const owner = await account("owner");
cookie = owner.cookie;
const ownerCookie = cookie;
const fakeKey = `fixture-only-${randomUUID()}`;
const model = (
  await request("/api/arena/models", {
    name: "Local encrypted fixture",
    provider: "openrouter",
    model: "fixture/no-network",
    apiKey: fakeKey,
    thinkMode: "never",
  })
).payload;
const listed = (await request("/api/arena/models")).payload;
assert.equal(listed.items.length, 1);
assert.ok(!JSON.stringify(listed).includes(fakeKey));
const credentials = (await request("/api/arena/credentials")).payload.items;
assert.equal(credentials.length, 1);
assert.ok(!JSON.stringify(credentials).includes(fakeKey));
assert.ok(!Object.hasOwn(credentials[0], "ciphertext"));
const credentialId = credentials[0].id;
const created = (
  await request("/api/arena/matches", {
    gameId: "gomoku",
    config: { size: 9 },
    seats: [{ kind: "human" }, { kind: "human" }],
  })
).payload;
const stream = openSocket(`/api/arena/matches/${created.id}/socket?seat=0`);
let moderatorRole;
try {
  assert.equal((await stream.first).id, created.id);
  for (const [ply, position] of [0, 9, 1, 10, 2, 11, 3, 12, 4].entries()) {
    const seat = ply % 2;
    const snapshot = (
      await request(`/api/arena/matches/${created.id}?seat=${seat}`)
    ).payload;
    const action = snapshot.view.legalActions.find(
      (candidate) => candidate.to === position,
    );
    assert.ok(action, "Expected legal placement");
    const result = (
      await request(`/api/arena/matches/${created.id}/commands?seat=${seat}`, {
        type: "action",
        operationId: randomUUID(),
        seat,
        version: snapshot.version,
        actionId: action.id,
      })
    ).payload;
    if (ply === 8) {
      assert.equal(result.status, "finished");
      assert.equal(result.view.result.winner, 0);
    }
  }
  assert.ok(stream.snapshots.length > 1, "WebSocket must deliver live updates");
  const post = (
    await request("/api/arena/community", {
      matchId: created.id,
      title: "Cloudflare integration fixture",
    })
  ).payload;
  const detail = (
    await request(`/api/arena/community/${post.id}`, undefined, { cookie: "" })
  ).payload;
  assert.ok(
    detail.replay.frames.length >= 10,
    "R2 replay is readable after publication",
  );
  assert.equal(detail.replay.result.winner, 0);
  const clone = (
    await request("/api/arena/matches", {
      cloneId: post.id,
      gameId: "xiangqi",
      config: { size: 15 },
      seats: [{ kind: "human" }, { kind: "human" }],
    })
  ).payload;
  assert.equal(clone.gameId, "gomoku");
  assert.equal(clone.view.rows, 9);
  const other = await account("other");
  const otherCookie = other.cookie;
  await request(`/api/arena/matches/${created.id}`, undefined, {
    cookie: otherCookie,
    status: 404,
  });
  assert.equal(
    (await request("/api/arena/models", undefined, { cookie: otherCookie }))
      .payload.items.length,
    0,
  );
  assert.equal(
    (
      await request("/api/arena/credentials", undefined, {
        cookie: otherCookie,
      })
    ).payload.items.length,
    0,
  );
  await request(
    "/api/arena/models/test",
    { id: model.id },
    { cookie: otherCookie, status: 404 },
  );
  await request(
    "/api/arena/matches",
    {
      gameId: "gomoku",
      seats: [{ kind: "ai", profileId: model.id }, { kind: "human" }],
    },
    { cookie: otherCookie, status: 404 },
  );
  await request(
    "/api/arena/models",
    {
      id: model.id,
      name: "Foreign edit",
      provider: "openrouter",
      model: "fixture/other",
      apiKey: "fixture-only-foreign-key",
    },
    { cookie: otherCookie, status: 404 },
  );
  await request(`/api/arena/models?id=${model.id}`, undefined, {
    cookie: otherCookie,
    method: "DELETE",
    status: 404,
  });
  await request(
    "/api/arena/credentials",
    {
      id: credentialId,
      name: "Foreign key edit",
      apiKey: "fixture-only-foreign-key",
    },
    { cookie: otherCookie, status: 404 },
  );
  await request(`/api/arena/credentials?id=${credentialId}`, undefined, {
    cookie: otherCookie,
    method: "DELETE",
    status: 404,
  });
  await request(
    "/api/arena/models",
    {
      name: "Foreign key use",
      provider: "openrouter",
      model: "fixture/other",
      credentialId,
    },
    { cookie: otherCookie, status: 404 },
  );
  assert.deepEqual(
    (await request("/api/arena/models")).payload,
    listed,
    "Foreign mutations must leave the owner model unchanged",
  );
  assert.deepEqual(
    (await request("/api/arena/credentials")).payload.items,
    credentials,
    "Foreign mutations must leave the owner key unchanged",
  );
  await request(
    `/api/arena/community/${post.id}`,
    { action: "comment", body: "Anonymous cannot comment" },
    { cookie: "", status: 401 },
  );
  await request(
    `/api/arena/community/${post.id}`,
    { action: "moderate" },
    { cookie: otherCookie, status: 403 },
  );
  // Rejected POST bodies must not break the local proxy's next pooled request.
  for (let i = 0; i < 30; i++) {
    for (const rejection of [
      { cookie: "", status: 401 },
      {
        cookie: otherCookie,
        headers: { Origin: "https://other.invalid" },
        status: 403,
      },
    ]) {
      await request(
        `/api/arena/community/${post.id}`,
        { action: "comment", body: "Rejected request body fixture" },
        rejection,
      );
      await request(
        `/api/arena/community/${post.id}`,
        { action: "moderate" },
        { cookie: otherCookie, status: 403 },
      );
    }
  }
  await request("/api/arena/community/reports", undefined, {
    cookie: otherCookie,
    status: 403,
  });
  for (let i = 0; i < 2; i++) {
    const liked = (
      await request(
        `/api/arena/community/${post.id}`,
        { action: "like", liked: true },
        { cookie: otherCookie },
      )
    ).payload;
    assert.equal(liked.likes, 1, "Repeated like must be idempotent");
    assert.equal(liked.liked, true);
  }
  const unliked = (
    await request(
      `/api/arena/community/${post.id}`,
      { action: "like", liked: false },
      { cookie: otherCookie },
    )
  ).payload;
  assert.equal(unliked.likes, 0);
  const comment = (
    await request(
      `/api/arena/community/${post.id}`,
      { action: "comment", body: "Fixture review: a complete legal win." },
      { cookie: otherCookie },
    )
  ).payload;
  const commented = (
    await request(`/api/arena/community/${post.id}`, undefined, { cookie: "" })
  ).payload;
  assert.equal(
    commented.comments.find((item) => item.id === comment.id)?.body,
    comment.body,
  );
  assert.equal(commented.post.commentCount, 1);
  for (let i = 0; i < 2; i++)
    await request(
      `/api/arena/community/${post.id}`,
      { action: "report", reason: "Fixture moderation review" },
      { cookie: otherCookie },
    );
  const moderator = await account("moderator");
  await request("/api/arena/community/reports", undefined, {
    cookie: moderator.cookie,
    status: 403,
  });
  moderatorRole = grantFixtureModerator(moderator);
  const reports = (
    await request("/api/arena/community/reports", undefined, {
      cookie: moderator.cookie,
    })
  ).payload.items.filter((item) => item.publicationId === post.id);
  assert.equal(reports.length, 1, "Repeated report must be idempotent");
  assert.equal(reports[0].reason, "Fixture moderation review");
  assert.equal(reports[0].reporterName, "Cloudflare smoke other");
  assert.equal(
    (
      await request(`/api/arena/community/${post.id}`, undefined, {
        cookie: moderator.cookie,
      })
    ).payload.isAdmin,
    true,
  );
  await request(
    "/api/arena/models",
    {
      name: "Forbidden",
      provider: "openrouter",
      model: "test",
      apiKey: fakeKey,
    },
    { headers: { Origin: "https://other.invalid" }, status: 403 },
  );
  await request(
    `/api/arena/community/${post.id}`,
    { action: "unpublish" },
    { cookie: ownerCookie },
  );
  await request(`/api/arena/community/${post.id}`, undefined, {
    cookie: "",
    status: 404,
  });
  await request(
    "/api/arena/matches",
    { cloneId: post.id, seats: [{ kind: "human" }, { kind: "human" }] },
    { status: 404 },
  );
  const republished = (
    await request("/api/arena/community", {
      matchId: created.id,
      title: "Republished moderation fixture",
    })
  ).payload;
  assert.equal(republished.id, post.id);
  const removed = (
    await request(
      `/api/arena/community/${post.id}`,
      { action: "moderate", reason: "Fixture takedown" },
      { cookie: moderator.cookie },
    )
  ).payload;
  assert.equal(removed.status, "removed");
  await request(`/api/arena/community/${post.id}`, undefined, {
    cookie: "",
    status: 404,
  });
  assert.ok(
    !(
      await request("/api/arena/community", undefined, { cookie: "" })
    ).payload.items.some((item) => item.id === post.id),
  );
  await request(
    "/api/arena/community",
    { matchId: created.id, title: "Cannot undo moderation" },
    { status: 403 },
  );
  await request(
    "/api/arena/matches",
    { cloneId: post.id, seats: [{ kind: "human" }, { kind: "human" }] },
    { status: 404 },
  );
  localSql(`UPDATE role SET status='disabled' WHERE id='${moderatorRole}';`);
  await request("/api/arena/community/reports", undefined, {
    cookie: moderator.cookie,
    status: 403,
  });
  await request(
    `/api/arena/community/${post.id}`,
    { action: "moderate" },
    { cookie: moderator.cookie, status: 403 },
  );
  moderatorRole = undefined;
  const removal = await fetch(`${origin}/api/arena/models?id=${model.id}`, {
    method: "DELETE",
    headers: { Origin: origin, Cookie: ownerCookie },
  });
  assert.equal(removal.status, 200);
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "auth",
        "encrypted-vault",
        "service-binding",
        "human-actions",
        "websocket-101-and-updates",
        "finished-result",
        "r2-replay",
        "clone",
        "tenant-match-isolation",
        "tenant-model-read-test-use-edit-delete-isolation",
        "tenant-credential-read-use-edit-delete-isolation",
        "origin-check",
        "rejected-post-connection-stability",
        "likes-idempotency-and-unlike",
        "comment-public-read",
        "reports-idempotency-and-admin-queue",
        "publication-withdrawal",
        "moderator-takedown-and-republish-denial",
        "moderator-role-revocation",
      ],
      websocketSnapshots: stream.snapshots.length,
    }),
  );
} finally {
  stream.close();
  if (moderatorRole)
    localSql(`UPDATE role SET status='disabled' WHERE id='${moderatorRole}';`);
}

await import('./smoke-arcade.mjs');
