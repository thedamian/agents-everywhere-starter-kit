import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { MovieError } from "../domain";

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function atomicWrite(filename: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const staging = `${filename}.${randomUUID()}.writing`;
  try {
    const handle = await open(staging, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await rename(staging, filename); break; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "") || attempt >= 9) throw error;
        // Windows readers/scanners may briefly hold the destination; never unlink the committed record.
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } finally { await rm(staging, { force: true }); }
}

export async function readJson(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(filename, "utf8"));
}

const queues = new Map<string, Promise<unknown>>();

/** Serialize short disk transactions both within a process and across web/worker processes. */
export async function withDiskLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(directory);
  const previous = queues.get(key) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    await mkdir(key, { recursive: true, mode: 0o700 });
    const lock = path.join(key, ".transaction-lock");
    const recovery = `${lock}.recovery`;
    const token = randomUUID();
    const candidate = path.join(key, `.transaction-${token}.owner`);
    await atomicWrite(candidate, JSON.stringify({ pid: process.pid, token }));
    const start = Date.now();
    type Owner = { pid: number; token: string };
    const ownerOf = async (filename: string): Promise<Owner | null> => {
      try {
        const value = await readJson(filename) as Owner;
        if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== "string") throw new Error("Invalid owner");
        return value;
      } catch (error) {
        if (isMissing(error)) return null;
        throw new MovieError("STORE_LOCK_INVALID", "The local transaction lock is invalid. Inspect the private store before restarting.", 503);
      }
    };
    const release = async (filename: string) => {
      if ((await ownerOf(filename))?.token === token) await rm(filename, { force: true });
    };
    let acquired = false;
    try {
      while (!acquired) {
        if (Date.now() - start > 15_000) throw new MovieError("STORE_BUSY", "The local store is busy. Try again shortly.", 503);
        const guard = await ownerOf(recovery);
        if (guard) {
          if (!processAlive(guard.pid) && (await ownerOf(recovery))?.token === guard.token) await rm(recovery, { force: true });
          await new Promise(resolve => setTimeout(resolve, 25));
          continue;
        }
        try {
          // Publishing an already-flushed file with an exclusive hard link leaves no partial owner record after a crash.
          await link(candidate, lock);
          acquired = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const owner = await ownerOf(lock);
        if (!owner) continue;
        if (!processAlive(owner.pid)) {
          try {
            await link(candidate, recovery);
            try {
              const current = await ownerOf(lock);
              if (current && !processAlive(current.pid)) await rm(lock, { force: true });
            } finally { await release(recovery); }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return await action();
    } finally {
      if (acquired) await release(lock);
      await rm(candidate, { force: true });
    }
  });
  queues.set(key, work);
  try { return await work; } finally { if (queues.get(key) === work) queues.delete(key); }
}
