import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, link, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const tokenPattern = /^[A-Za-z0-9._~-]{24,256}$/;

function matches(left, right) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function storedCredential(file) {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("The stored studio credential must be a regular private file.");
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 24 || info.size > 258) {
      throw new Error("The stored studio credential is invalid; it will not be replaced.");
    }
    const bytes = Buffer.alloc(259);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error("The stored studio credential changed while being read; restart was refused.");
    const token = bytes.subarray(0, length).toString("utf8").replace(/\r?\n$/, "");
    if (!tokenPattern.test(token)) throw new Error("The stored studio credential is invalid; it will not be replaced.");
    return token;
  } finally {
    await handle.close();
  }
}

export async function persistentStudioCredential(directory, configuredTokens = []) {
  if (!isAbsolute(directory)) throw new Error("The studio credential directory must be an absolute private path.");
  const configured = configuredTokens.filter(value => value !== undefined && value !== "").map(value => {
    if (typeof value !== "string" || !tokenPattern.test(value.trim())) {
      throw new Error("Configured studio credentials must contain 24-256 bearer-safe characters.");
    }
    return value.trim();
  });
  if (configured.some(token => !matches(token, configured[0]))) {
    throw new Error("FinalProject and MoviePart studio credentials must agree before launch.");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "studio-api-token");
  const verify = token => {
    if (configured.length && !matches(token, configured[0])) {
      throw new Error("The configured studio credential differs from the stored identity. Complete existing studio cleanup before deliberate credential rotation.");
    }
    return token;
  };
  try {
    return verify(await storedCredential(file));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const candidate = configured[0] ?? randomBytes(32).toString("base64url");
  const temporary = join(directory, `.studio-api-token-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${candidate}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Linking publishes a complete file atomically without replacing another launcher's identity.
    try { await link(temporary, file); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return verify(await storedCredential(file));
  } finally {
    await unlink(temporary);
  }
}
