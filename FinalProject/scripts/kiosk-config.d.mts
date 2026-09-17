export interface KioskLaunchOptions {
  liveMedia: boolean;
  liveStudio: boolean;
  liveVoice: boolean;
  googleCalendar: boolean;
  windowsBridge: boolean;
  apiPort: number;
  uiPort: number;
  mediaPort: number;
  publicOrigin?: string;
  startupTimeoutMs: number;
}
export function optionalEnvironment(path: string): Promise<Record<string, string>>;
export function launchOptions(args: string[]): KioskLaunchOptions;
export function studioReady(value: unknown): boolean;
export function apiReady(value: unknown, options: KioskLaunchOptions): boolean;
export function integrationEnvironments(input: {
  parent?: NodeJS.ProcessEnv;
  finalEnv?: Record<string, string>;
  movieEnv?: Record<string, string>;
  robotEnv?: Record<string, string>;
  options: KioskLaunchOptions;
  deviceToken: string;
  mediaToken: string;
  studioToken?: string;
  operatorToken?: string;
}): {
  api: NodeJS.ProcessEnv;
  ui: NodeJS.ProcessEnv;
  media: NodeJS.ProcessEnv;
  worker: NodeJS.ProcessEnv;
  apiOrigin: string;
  uiOrigin: string;
  publicOrigin: string;
  mediaOrigin: string;
};
