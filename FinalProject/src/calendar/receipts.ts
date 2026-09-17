import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { CalendarError } from "./errors.js";
import { OAuthTokensSchema, type OAuthTokens, type OAuthTokenStore } from "./oauth.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const CalendarReceiptSchema = z.object({
  version: z.literal(1),
  confirmationKey: hash, fingerprint: hash,
  calendarId: z.string().min(1).max(300), eventId: z.string().regex(/^[0-9a-v]{5,1024}$/),
  state: z.enum(["pending", "created", "cancelling", "cancelled"]),
  htmlLink: z.string().optional(),
  invitationsRequested: z.boolean(),
  cancellationUpdatesRequested: z.boolean(),
  updatedAt: z.iso.datetime(),
}).strict();
export type CalendarReceiptRecord = z.infer<typeof CalendarReceiptSchema>;
export interface CalendarReceiptStore {
  load(confirmationKey: string): Promise<CalendarReceiptRecord | undefined>;
  save(receipt: CalendarReceiptRecord): Promise<void>;
}
export interface BookingReceipt {
  status: "created" | "cancelled";
  calendarId: string;
  eventId: string;
  htmlLink?: string;
  invitationsRequested: boolean;
  cancellationUpdatesRequested: boolean;
  inventoryReserved: false;
}

function storageFailure(): CalendarError {
  return new CalendarError("CALENDAR_STORAGE_FAILED", "Private calendar storage is unavailable; operator attention is required before retrying.", 503);
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function readPrivateJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (isMissing(error)) return undefined;
    throw storageFailure();
  }
}
async function writePrivateJson(directory: string, filename: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value), "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, join(directory, filename));
  } catch {
    throw storageFailure();
  } finally {
    try { await rm(temporary, { force: true }); } catch { throw storageFailure(); }
  }
}
function validateDirectory(directory: string): void {
  if (!isAbsolute(directory)) throw new CalendarError("CALENDAR_STORAGE_INVALID", "Private calendar storage requires an absolute directory path.", 503);
}

export class FileCalendarReceiptStore implements CalendarReceiptStore {
  constructor(private readonly directory: string) { validateDirectory(directory); }
  async load(key: string): Promise<CalendarReceiptRecord | undefined> {
    if (!hash.safeParse(key).success) throw storageFailure();
    const body = await readPrivateJson(join(this.directory, `${key}.json`));
    if (body === undefined) return undefined;
    const parsed = CalendarReceiptSchema.safeParse(body);
    if (!parsed.success || parsed.data.confirmationKey !== key) throw storageFailure();
    return parsed.data;
  }
  async save(receipt: CalendarReceiptRecord): Promise<void> {
    const parsed = CalendarReceiptSchema.safeParse(receipt);
    if (!parsed.success) throw storageFailure();
    await writePrivateJson(this.directory, `${receipt.confirmationKey}.json`, parsed.data);
  }
}

export class FileOAuthTokenStore implements OAuthTokenStore {
  constructor(private readonly directory: string) { validateDirectory(directory); }
  async load(): Promise<OAuthTokens | undefined> {
    const body = await readPrivateJson(join(this.directory, "google-oauth.json"));
    if (body === undefined) return undefined;
    const parsed = OAuthTokensSchema.safeParse(body);
    if (!parsed.success) throw storageFailure();
    return parsed.data;
  }
  async save(tokens: OAuthTokens): Promise<void> {
    const parsed = OAuthTokensSchema.safeParse(tokens);
    if (!parsed.success) throw storageFailure();
    await writePrivateJson(this.directory, "google-oauth.json", parsed.data);
  }
  async clear(): Promise<void> {
    try { await rm(join(this.directory, "google-oauth.json"), { force: true }); } catch { throw storageFailure(); }
  }
}
