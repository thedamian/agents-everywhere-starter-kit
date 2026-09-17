import { z } from "zod";
import { MovieError, type MovieJob } from "../domain";

export const lifecycleKeySchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const jobReceiptSchema = z.object({
  jobId: z.uuid().nullable(),
  fingerprint: z.string().nullable(),
  cancelledAt: z.iso.datetime().optional(),
  assetsDeleted: z.boolean().optional(),
}).strict();
export type JobReceipt = z.infer<typeof jobReceiptSchema>;

export function assertJobNotCancelled(job: MovieJob): void {
  if (job.error?.code === "JOB_CANCELLED") {
    throw new MovieError("JOB_CANCELLED", "This movie request was cancelled and cannot be restarted.", 410);
  }
}

export function referencedAssets(job: MovieJob): string[] {
  return [
    ...job.request.customer_reference_asset_ids, ...job.product.referenceImages.map(ref => ref.assetId),
    ...job.frames.map(frame => frame.assetId), ...(job.character?.sourceImages.map(ref => ref.assetId) ?? []),
    ...(job.sceneFrames?.map(frame => frame.assetId) ?? []),
    ...(job.hero ? [job.hero.assetId] : []), ...(job.result ? [job.result.assetId] : []),
    ...(job.videoSegments ?? []).flatMap(segment => [
      ...(segment.clip ? [segment.clip.assetId] : []), ...(segment.startFrameAssetId ? [segment.startFrameAssetId] : []),
    ]),
  ];
}
