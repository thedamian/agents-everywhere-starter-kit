import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  StudioHeroModeSchema, StudioProductionModeSchema, StudioTemplateIdSchema,
  StudioVideoProviderSchema, StudioInputSchema,
} from '../../FinalProject/src/contracts/showroom.js';
import {
  heroModeSchema, jobRequestSchema, productionModeSchema, templateIdSchema, videoProviderSchema,
} from '../src/domain/index.js';
import type { StudioInput } from '../integration/dwight/showroom-v1/types.js';

test('showroom catalog choices match the real creator studio domain', () => {
  assert.deepEqual(StudioHeroModeSchema.options, heroModeSchema.options);
  assert.deepEqual(StudioProductionModeSchema.options, productionModeSchema.options);
  assert.deepEqual(StudioTemplateIdSchema.options, templateIdSchema.options);
  assert.deepEqual(StudioVideoProviderSchema.options, videoProviderSchema.options);
});

test('shared executable studio input and generated portable type adapt to the complete creator request', async () => {
  const examples = JSON.parse(await readFile(new URL('../integration/dwight/showroom-v1/examples.json', import.meta.url), 'utf8'));
  const input: StudioInput = StudioInputSchema.parse(examples.AcceptedStudioSnapshotSchema.input);
  const selected = input.selection;
  const request = jobRequestSchema.parse({
    schema_version: 1,
    session_id: input.sessionId,
    customer_reference_asset_ids: input.captureSet?.references.map((reference) => reference.assetId) ?? [],
    primary_reference_asset_id: input.captureSet?.primaryAssetId ?? null,
    consent: { likeness: true, personalization: true },
    product_id: selected.productId,
    personalization_profile: input.context,
    preferred_template: selected.templateId,
    hero_mode: selected.heroMode,
    production_mode: selected.productionMode,
    story_format: selected.storyFormat,
    render_layout: selected.renderLayout,
    ...(selected.movieDurationSeconds === null ? {} : { movie_duration_seconds: selected.movieDurationSeconds }),
    ...(selected.videoProvider === null ? {} : { video_provider: selected.videoProvider }),
    enable_hero_video: selected.enableHeroVideo,
    idempotency_key: examples.AcceptedStudioSnapshotSchema.snapshotId,
  });
  assert.equal(request.product_id, 'toyota-camry');
  assert.equal(request.video_provider, 'google-veo');
  assert.equal(request.customer_reference_asset_ids.length, 1);
});
