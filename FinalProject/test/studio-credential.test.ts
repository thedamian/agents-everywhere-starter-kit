import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { persistentStudioCredential } from "../scripts/studio-credential.mjs";

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "showroom-credential-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("normal restarts retain one private studio identity instead of rotating job ownership", async t => {
  const root = await directory(t);
  const first = await persistentStudioCredential(root);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await persistentStudioCredential(root), first);
  assert.equal(await readFile(join(root, "studio-api-token"), "utf8"), `${first}\n`);
  assert.deepEqual(await readdir(root), ["studio-api-token"]);
});

test("concurrent initial launchers atomically adopt the same complete credential", async t => {
  const root = await directory(t);
  const tokens = await Promise.all(Array.from({ length: 12 }, () => persistentStudioCredential(root)));
  assert.equal(new Set(tokens).size, 1);
  assert.match(tokens[0]!, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await readdir(root), ["studio-api-token"]);
});

test("configured credentials are initially adopted but conflicting rotation never replaces the owner", async t => {
  const root = await directory(t);
  const configured = "test-original-studio-identity-1234567890";
  const other = "test-rotated-studio-identity-12345678901";
  assert.equal(await persistentStudioCredential(root, [configured, configured]), configured);
  assert.equal(await persistentStudioCredential(root, [undefined, configured]), configured);
  await assert.rejects(persistentStudioCredential(root, [other]), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /differs from the stored identity/);
    assert.ok(!error.message.includes(configured));
    assert.ok(!error.message.includes(other));
    return true;
  });
  assert.equal(await persistentStudioCredential(root), configured);
  assert.equal(await readFile(join(root, "studio-api-token"), "utf8"), `${configured}\n`);
});

test("disagreeing or invalid configuration fails before publishing any credential", async t => {
  const root = await directory(t);
  await assert.rejects(persistentStudioCredential(root, ["test-first-studio-identity-12345", "test-other-studio-identity-12345"]), /must agree/);
  for (const value of ["short", "unsafe bearer token 1234567890", "x".repeat(257)]) {
    await assert.rejects(persistentStudioCredential(root, [value]), /24-256/);
  }
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(persistentStudioCredential("relative-directory"), /absolute/);
});

test("corrupt or non-file stored credentials fail closed and are never regenerated", async t => {
  const root = await directory(t);
  const file = join(root, "studio-api-token");
  for (const value of ["", "short", "x".repeat(259), "line-one\nline-two", ` ${"x".repeat(32)}`]) {
    await writeFile(file, value);
    await assert.rejects(persistentStudioCredential(root), /invalid/);
    assert.equal(await readFile(file, "utf8"), value);
  }
  await rm(file);
  await mkdir(file);
  await assert.rejects(persistentStudioCredential(root), /regular private file/);
});
