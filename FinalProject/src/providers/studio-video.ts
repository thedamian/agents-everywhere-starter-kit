import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ffprobe from 'ffprobe-static';
import { z } from 'zod';
import { ProviderFailure } from './http-client.js';

const probeSchema = z.object({
  format: z.object({ format_name: z.string(), duration: z.coerce.number().positive().finite() }),
  streams: z.array(z.object({
    codec_type: z.string(), codec_name: z.string().optional(),
    width: z.number().optional(), height: z.number().optional(),
    pix_fmt: z.string().optional(), nb_read_frames: z.coerce.number().optional(),
    avg_frame_rate: z.string().optional(),
  })),
});

async function probe(file: string, signal: AbortSignal, executable: string): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [
      '-v', 'error', '-protocol_whitelist', 'file,pipe', '-count_frames',
      '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,pix_fmt,nb_read_frames,avg_frame_rate',
      '-of', 'json', '-i', file,
    ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let size = 0;
    const output: Buffer[] = [];
    let failure: unknown;
    const stop = (error: unknown) => { failure ??= error; child.kill('SIGKILL'); };
    const onAbort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new ProviderFailure('STUDIO_VIDEO_INVALID', 'Movie validation timed out.')), 60_000);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) stop(new ProviderFailure('STUDIO_VIDEO_INVALID', 'Movie metadata exceeded the validation limit.'));
      else output.push(chunk);
    });
    child.once('error', () => { failure ??= new ProviderFailure('STUDIO_VIDEO_INVALID', 'The local movie validator could not start.'); });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new ProviderFailure('STUDIO_VIDEO_INVALID', 'The completed studio movie could not be decoded.'));
      else resolveResult(Buffer.concat(output).toString('utf8'));
    });
  });
}

export async function validateStudioVideo(
  bytes: Uint8Array, durationSeconds: number, signal: AbortSignal,
  options: { directory?: string; executable?: string } = {},
): Promise<void> {
  if (bytes.byteLength < 24 || Buffer.from(bytes.subarray(4, 8)).toString('ascii') !== 'ftyp') {
    throw new ProviderFailure('STUDIO_VIDEO_INVALID', 'The studio result is not an MP4.');
  }
  const root = resolve(options.directory ?? '.runtime/studio-validation');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'movie-'));
  try {
    const file = join(directory, 'movie.mp4');
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600, signal });
    let value: unknown;
    try { value = JSON.parse(await probe(file, signal, options.executable ?? ffprobe.path)); } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProviderFailure) throw error;
      throw new ProviderFailure('STUDIO_VIDEO_INVALID', 'Movie validation did not return valid metadata.');
    }
    const parsed = probeSchema.safeParse(value);
    if (!parsed.success) throw new ProviderFailure('STUDIO_VIDEO_INVALID', 'Movie validation returned incomplete metadata.');
    const data = parsed.data;
    const videos = data.streams.filter(stream => stream.codec_type === 'video');
    const video = videos[0];
    const audio = data.streams.filter(stream => stream.codec_type === 'audio');
    if (!data.format.format_name.split(',').includes('mp4') || videos.length !== 1
        || video?.codec_name !== 'h264' || video.width !== 1280 || video.height !== 720
        || video.pix_fmt !== 'yuv420p' || video.nb_read_frames !== durationSeconds * 24
        || !['24/1', '24'].includes(video.avg_frame_rate ?? '')
        || Math.abs(data.format.duration - durationSeconds) > 0.08
        || audio.length > 1 || audio.some(stream => stream.codec_name !== 'aac')) {
      throw new ProviderFailure('STUDIO_VIDEO_INVALID', 'The completed studio movie does not match its promised 720p H.264 timeline.');
    }
    signal.throwIfAborted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
