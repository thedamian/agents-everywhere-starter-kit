import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { assetSchema, consentSchema, MovieError, type AssetRecord, type Consent } from "../domain";
import type { MediaRepository } from "../domain/services";
import { atomicWrite, isMissing, readJson, withDiskLock } from "./files";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 25_000_000;
export const PRODUCT_OWNER = "shared:catalog";
const storedAssetSchema = z.object({
  asset: assetSchema,
  consent: consentSchema.nullable(),
  sourceHash: z.string().nullable(),
}).strict();
type StoredAsset = z.infer<typeof storedAssetSchema>;

export function assertAssetId(id: string): void {
  if (!z.uuid().safeParse(id).success) throw new MovieError("ASSET_NOT_FOUND", "Asset not found.", 404);
}

export async function normalizeImage(bytes: Uint8Array): Promise<{ bytes: Buffer; width: number; height: number }> {
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new MovieError("IMAGE_TOO_LARGE", "Each photo must be between 1 byte and 10 MiB.", 413);
  }
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning", animated: true });
    const metadata = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) {
      throw new MovieError("INVALID_IMAGE", "Use a single-frame JPEG, PNG, or WebP image.", 400);
    }
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
      throw new MovieError("IMAGE_TOO_LARGE", "Photos must not exceed 25 megapixels.", 413);
    }
    const output = await image.rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
    if (output.data.byteLength > MAX_IMAGE_BYTES) {
      throw new MovieError("IMAGE_TOO_LARGE", "The normalized photo exceeds 10 MiB. Resize the image before uploading.", 413);
    }
    return { bytes: output.data, width: output.info.width, height: output.info.height };
  } catch (error) {
    if (error instanceof MovieError) throw error;
    throw new MovieError("INVALID_IMAGE", "The photo could not be decoded, or exceeds 25 megapixels.", 400);
  }
}

export class LocalMediaRepository implements MediaRepository {
  readonly directory: string;
  constructor(dataDir: string) { this.directory = path.join(path.resolve(dataDir), "assets"); }

  private metadataPath(id: string): string {
    assertAssetId(id);
    return path.join(this.directory, `${id}.json`);
  }

  private async stored(id: string): Promise<StoredAsset> {
    try {
      const stored = storedAssetSchema.parse(await readJson(this.metadataPath(id)));
      if (stored.asset.id !== id || stored.asset.filename !== `${id}.media`) throw new Error("Invalid asset metadata");
      return stored;
    } catch (error) {
      if (error instanceof MovieError) throw error;
      throw new MovieError("ASSET_NOT_FOUND", "Asset not found.", 404);
    }
  }

  async getAsset(id: string): Promise<AssetRecord> { return (await this.stored(id)).asset; }
  async assetPath(id: string): Promise<string> {
    const asset = await this.getAsset(id);
    return path.join(this.directory, asset.filename);
  }
  async readAsset(id: string): Promise<Uint8Array> { return readFile(await this.assetPath(id)); }
  async getConsent(id: string): Promise<Consent | null> { return (await this.stored(id)).consent; }
  async getSourceHash(id: string): Promise<string | null> { return (await this.stored(id)).sourceHash; }
  async requireOwned(id: string, ownerId: string): Promise<AssetRecord> {
    const asset = await this.getAsset(id);
    if (asset.ownerId !== ownerId) throw new MovieError("ASSET_NOT_FOUND", "Asset not found.", 404);
    return asset;
  }

  async saveAsset(input: Parameters<MediaRepository["saveAsset"]>[0]): Promise<AssetRecord> {
    return this.persist(input, randomUUID(), null, null);
  }

  private async persist(
    input: Parameters<MediaRepository["saveAsset"]>[0], id: string, consent: Consent | null, sourceHash: string | null,
  ): Promise<AssetRecord> {
    const asset = assetSchema.parse({
      id, ownerId: input.ownerId, jobId: input.jobId, kind: input.kind, mime: input.mime,
      filename: `${id}.media`, bytes: input.bytes.byteLength, width: input.width ?? null,
      height: input.height ?? null, createdAt: new Date().toISOString(),
    });
    // Publish ownership before bytes so interrupted writes remain discoverable for cleanup.
    await atomicWrite(this.metadataPath(id), JSON.stringify({ asset, consent, sourceHash }));
    await atomicWrite(path.join(this.directory, asset.filename), input.bytes);
    return asset;
  }

  async saveCustomer(input: { ownerId: string; image: Awaited<ReturnType<typeof normalizeImage>>; consent: Consent; id?: string }): Promise<AssetRecord> {
    consentSchema.parse(input.consent);
    return this.persist({
      ownerId: input.ownerId, jobId: null, kind: "customer", mime: "image/jpeg", ...input.image,
    }, input.id ?? randomUUID(), input.consent, createHash("sha256").update(input.image.bytes).digest("hex"));
  }

  async saveProduct(bytes: Uint8Array): Promise<AssetRecord> {
    const hash = createHash("sha256").update("movie-normalized-image-v1\0").update(bytes).digest("hex");
    const raw = hash.slice(0, 32).split("");
    raw[12] = "5";
    raw[16] = ((parseInt(raw[16], 16) & 3) | 8).toString(16);
    const hex = raw.join("");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return withDiskLock(path.join(this.directory, "catalog-cache"), async () => {
      try {
        const stored = await this.stored(id);
        if (stored.sourceHash === hash && stored.asset.ownerId === PRODUCT_OWNER) {
          const file = await stat(await this.assetPath(id));
          if (file.size === stored.asset.bytes) return stored.asset;
        }
      } catch (error) {
        if (!(error instanceof MovieError) && !isMissing(error)) throw error;
      }
      const image = await normalizeImage(bytes);
      return this.persist({ ownerId: PRODUCT_OWNER, jobId: null, kind: "product", mime: "image/jpeg", ...image }, id, null, hash);
    });
  }

  async listAssets(): Promise<AssetRecord[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.directory);
    const assets = await Promise.all(files.filter(file => file.endsWith(".json")).map(file =>
      this.getAsset(file.slice(0, -5)).catch(() => null)));
    return assets.filter((asset): asset is AssetRecord => asset !== null);
  }

  async deleteOwned(id: string, ownerId: string): Promise<void> {
    const asset = await this.requireOwned(id, ownerId);
    if (asset.ownerId === PRODUCT_OWNER) return;
    await rm(path.join(this.directory, asset.filename), { force: true });
    for (const name of await readdir(this.directory)) {
      if ((name.startsWith(`${id}.media.`) || name.startsWith(`${id}.json.`)) && name.endsWith(".writing")) {
        await rm(path.join(this.directory, name), { force: true });
      }
    }
    await rm(this.metadataPath(id), { force: true });
  }
}
