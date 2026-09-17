import { z } from "zod";
import { MovieError } from "../domain";
import { vehicleChoice } from "../catalog/vehicles";
import { ProductCatalog } from "./catalog";
import { MAX_IMAGE_BYTES, normalizeImage } from "./media";
import { boundedBody } from "./uploads";

const metadataSchema = z.object({
  permissionConfirmed: z.literal(true),
  source: z.string().trim().min(5).max(1000),
  exteriorColor: z.string().trim().min(1).max(100),
  interiorColor: z.string().trim().max(100).nullable(),
}).strict();

export async function uploadProductReferences(request: Request, productId: string, catalog: ProductCatalog) {
  if (!vehicleChoice(productId)) throw new MovieError("UNKNOWN_PRODUCT", "Choose a supported Toyota or Lexus vehicle.", 400);
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) throw new MovieError("INVALID_UPLOAD", "Upload vehicle references as multipart/form-data.", 415);
  const bytes = await boundedBody(request, 2 * MAX_IMAGE_BYTES + 16 * 1024);
  let form: FormData;
  try {
    form = await new Request(request.url, { method: "POST", headers: { "content-type": contentType }, body: Buffer.from(bytes) }).formData();
  } catch { throw new MovieError("INVALID_UPLOAD", "Vehicle reference upload could not be parsed.", 400); }
  if ([...form.keys()].some(key => !["exterior", "interior", "metadata"].includes(key)) ||
      ["exterior", "interior", "metadata"].some(key => form.getAll(key).length !== 1)) {
    throw new MovieError("INVALID_UPLOAD", "Provide one exterior photo, one interior photo, and permission metadata.", 400);
  }
  let metadata: z.infer<typeof metadataSchema>;
  try { metadata = metadataSchema.parse(JSON.parse(String(form.get("metadata")))); } catch {
    throw new MovieError("PRODUCT_PERMISSION_REQUIRED", "Confirm permission, describe the source, and specify the actual car color.", 400);
  }
  const images: Uint8Array[] = [];
  for (const key of ["exterior", "interior"]) {
    const file = form.get(key);
    if (!file || typeof file === "string" || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > MAX_IMAGE_BYTES) {
      throw new MovieError("INVALID_IMAGE", "Vehicle references must be JPEG, PNG or WebP files no larger than 10 MiB.", 400);
    }
    images.push((await normalizeImage(new Uint8Array(await file.arrayBuffer()))).bytes);
  }
  const product = await catalog.install({
    id: productId, exterior: images[0], interior: images[1], exteriorColor: metadata.exteriorColor,
    interiorColor: metadata.interiorColor || null, permission: `Operator confirmed permission for generation and advertising. Source: ${metadata.source}`,
  });
  return { id: product.id, name: product.name, ready: true };
}
