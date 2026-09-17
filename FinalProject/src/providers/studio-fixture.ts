import { ShowroomCatalogSchema } from '../contracts/showroom.js';
import { DEMO_MEDIA, validateDemoMedia } from './demo-media.js';
import type { StudioProvider } from './studio.js';

const fixtureProducts = [
  ['toyota-4runner', 'Toyota 4Runner'],
  ['toyota-bz', 'Toyota bZ (BEV)'],
  ['toyota-camry', 'Toyota Camry'],
  ['toyota-corolla', 'Toyota Corolla'],
  ['toyota-corolla-cross', 'Toyota Corolla Cross'],
  ['toyota-crown', 'Toyota Crown'],
  ['toyota-crown-signia', 'Toyota Crown Signia'],
  ['toyota-gr86', 'Toyota GR86'],
  ['toyota-gr-corolla', 'Toyota GR Corolla'],
  ['toyota-gr-supra', 'Toyota GR Supra'],
  ['toyota-highlander', 'Toyota Highlander'],
  ['toyota-land-cruiser', 'Toyota Land Cruiser'],
  ['toyota-mirai', 'Toyota Mirai'],
  ['toyota-prius', 'Toyota Prius'],
  ['toyota-rav4', 'Toyota RAV4'],
  ['toyota-sequoia', 'Toyota Sequoia'],
  ['toyota-sienna', 'Toyota Sienna'],
  ['toyota-tacoma', 'Toyota Tacoma'],
  ['toyota-tundra', 'Toyota Tundra'],
  ['lexus-es', 'Lexus ES'],
  ['lexus-gx', 'Lexus GX'],
  ['lexus-is', 'Lexus IS'],
  ['lexus-lc', 'Lexus LC'],
  ['lexus-ls', 'Lexus LS'],
  ['lexus-lx', 'Lexus LX'],
  ['lexus-nx', 'Lexus NX'],
  ['lexus-rc', 'Lexus RC'],
  ['lexus-rx', 'Lexus RX'],
  ['lexus-rz', 'Lexus RZ (BEV)'],
  ['lexus-ux', 'Lexus UX'],
] as const;

export function createFixtureStudioProvider(bytes: Uint8Array): StudioProvider {
  validateDemoMedia(bytes);
  const fixture = Uint8Array.from(bytes);
  return {
    async catalog(signal) {
      signal.throwIfAborted();
      return ShowroomCatalogSchema.parse({
        mode: 'fixture',
        products: fixtureProducts.map(([id, name]) => ({ id, name: `${name} (demo selection only)`, ready: true })),
        templates: [
          { id: 'VELOCITY', name: 'Velocity' }, { id: 'TOMORROW_DRIVE', name: 'Tomorrow drive' },
          { id: 'DREAM_ROUTE', name: 'Dream route' }, { id: 'HERO_OF_THE_DAY', name: 'Hero of the day' },
        ],
        videoProviders: [{ id: 'google-veo', available: true }, { id: 'openai-sora', available: true }],
        workerAvailable: true, rendererAvailable: true,
      });
    },
    async generate(snapshot, _photos, signal, progress) {
      signal.throwIfAborted();
      progress('registered_demo');
      return {
        bytes: Uint8Array.from(fixture), mimeType: 'video/mp4', provenance: 'mock_fixture',
        durationSeconds: DEMO_MEDIA.durationSeconds, productionMode: snapshot.input.selection.productionMode,
        renderMode: 'registered-demo',
      };
    },
    async cleanup() { return true; },
    async recoverCleanup() {},
  };
}
