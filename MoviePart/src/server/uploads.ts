import { createHash } from "node:crypto";
import { consentSchema, MovieError, type AssetRecord } from "../domain";
import { LocalMediaRepository, MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, normalizeImage } from "./media";

export async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw new MovieError("BODY_TOO_LARGE", "The request exceeds the allowed size.", 413);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new MovieError("BODY_TOO_LARGE", "The request exceeds the allowed size.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function parsePhotos(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
    throw new MovieError("INVALID_UPLOAD", "Send multipart/form-data with photos and consent.", 415);
  }
  const bytes = await boundedBody(request, MAX_UPLOAD_BYTES);
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST", headers: { "content-type": request.headers.get("content-type")! }, body: Buffer.from(bytes),
    }).formData();
  } catch {
    throw new MovieError("INVALID_UPLOAD", "The multipart upload could not be parsed.", 400);
  }
  const photos = form.getAll("photos");
  const consents = form.getAll("consent");
  if ([...form.keys()].some(key => key !== "photos" && key !== "consent") || consents.length !== 1 ||
      typeof consents[0] !== "string" || photos.length < 1 || photos.length > 4) {
    throw new MovieError("INVALID_UPLOAD", "Provide 1–4 photos and one JSON consent field.", 400);
  }
  let consent;
  try { consent = consentSchema.parse(JSON.parse(consents[0])); } catch {
    throw new MovieError("CONSENT_REQUIRED", "Likeness and personalization consent must both be true.", 400);
  }
  const images: Awaited<ReturnType<typeof normalizeImage>>[] = [];
  const unique = new Set<string>();
  for (const photo of photos) {
    if (typeof photo === "string" || !["image/jpeg", "image/png", "image/webp"].includes(photo.type)) {
      throw new MovieError("INVALID_IMAGE", "Photos must be JPEG, PNG, or WebP files.", 400);
    }
    if (!photo.size || photo.size > MAX_IMAGE_BYTES) {
      throw new MovieError("IMAGE_TOO_LARGE", "Each photo must be between 1 byte and 10 MiB.", 413);
    }
    const image = await normalizeImage(new Uint8Array(await photo.arrayBuffer()));
    const hash = createHash("sha256").update(image.bytes).digest("hex");
    if (unique.has(hash)) throw new MovieError("DUPLICATE_PHOTO", "Choose unique customer photos.", 400);
    unique.add(hash);
    images.push(image);
  }
  return { images, consent };
}

export async function uploadPhotos(request: Request, ownerId: string, media: LocalMediaRepository): Promise<AssetRecord[]> {
  const { images, consent } = await parsePhotos(request);
  const assets: AssetRecord[] = [];
  try {
    for (const image of images) assets.push(await media.saveCustomer({ ownerId, image, consent }));
    return assets;
  } catch (error) {
    await Promise.all(assets.map(asset => media.deleteOwned(asset.id, ownerId)));
    throw error;
  }
}
