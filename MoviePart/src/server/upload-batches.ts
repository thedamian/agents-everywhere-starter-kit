import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { MovieError } from "../domain";
import { JobStore } from "../jobs/store";
import { lifecycleKeySchema, referencedAssets } from "../jobs/lifecycle";
import { atomicWrite, isMissing, readJson, withDiskLock } from "./files";
import { LocalMediaRepository } from "./media";
import { parsePhotos } from "./uploads";

const receiptSchema = z.object({
  key: lifecycleKeySchema,
  fingerprint: z.string().nullable(),
  state: z.enum(["uploading", "uploaded", "cancelled"]),
  assetIds: z.array(z.uuid()).max(4),
  assetsDeleted: z.boolean(),
}).strict();
export type UploadBatchReceipt = z.infer<typeof receiptSchema>;

export class UploadBatchStore {
  constructor(private readonly jobs: JobStore, private readonly media: LocalMediaRepository) {}

  private filename(ownerId: string, key: string): string {
    lifecycleKeySchema.parse(key);
    const hash = createHash("sha256").update(JSON.stringify([ownerId, key])).digest("hex");
    return path.join(this.jobs.directory, "upload-batches", `${hash}.json`);
  }

  async get(ownerId: string, key: string): Promise<UploadBatchReceipt | null> {
    const value = await readJson(this.filename(ownerId, key)).catch(error => {
      if (isMissing(error)) return null;
      throw error;
    });
    return value === null ? null : receiptSchema.parse(value);
  }

  async upload(request: Request, ownerId: string, key: string): Promise<UploadBatchReceipt> {
    lifecycleKeySchema.parse(key);
    const { images, consent } = await parsePhotos(request);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      consent, images: images.map(image => createHash("sha256").update(image.bytes).digest("hex")),
    })).digest("hex");
    return withDiskLock(this.jobs.directory, async () => {
      const previous = await this.get(ownerId, key);
      if (previous?.state === "cancelled") throw new MovieError("UPLOAD_CANCELLED", "This upload batch was cancelled and cannot be reused.", 410);
      if (previous && previous.fingerprint !== fingerprint) {
        throw new MovieError("IDEMPOTENCY_CONFLICT", "This upload key was used for different photos or consent.", 409);
      }
      if (previous?.state === "uploaded") return previous;
      const receipt: UploadBatchReceipt = previous ?? {
        key, fingerprint, state: "uploading", assetIds: images.map(() => randomUUID()), assetsDeleted: false,
      };
      // Allocate IDs durably before the first write, including uploads interrupted between files.
      await atomicWrite(this.filename(ownerId, key), JSON.stringify(receipt));
      for (const [index, image] of images.entries()) {
        await this.media.saveCustomer({ ownerId, image, consent, id: receipt.assetIds[index] });
      }
      receipt.state = "uploaded";
      await atomicWrite(this.filename(ownerId, key), JSON.stringify(receipt));
      return receipt;
    });
  }

  async cancel(ownerId: string, key: string): Promise<UploadBatchReceipt> {
    return withDiskLock(this.jobs.directory, async () => {
      const receipt: UploadBatchReceipt = await this.get(ownerId, key) ?? {
        key: lifecycleKeySchema.parse(key), fingerprint: null, state: "cancelled", assetIds: [], assetsDeleted: false,
      };
      receipt.state = "cancelled";
      await atomicWrite(this.filename(ownerId, key), JSON.stringify(receipt));
      const referenced = new Set((await this.jobs.list()).flatMap(referencedAssets));
      let deleted = true;
      for (const id of receipt.assetIds) {
        if (referenced.has(id)) { deleted = false; continue; }
        try { await this.media.deleteOwned(id, ownerId); } catch (error) {
          if (!(error instanceof MovieError && error.code === "ASSET_NOT_FOUND")) throw error;
        }
      }
      receipt.assetsDeleted = deleted;
      await atomicWrite(this.filename(ownerId, key), JSON.stringify(receipt));
      return receipt;
    });
  }
}
