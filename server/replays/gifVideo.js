// ---------------------------------------------------------------------------
// server/replays/gifVideo.js
// The conversions behind saved GIFs, all through ffmpeg. A clip is kept as an
// MP4 (about a tenth of the bytes, and none of a GIF's 256 colour limit); a GIF
// is only made when someone asks for one.
//
// One job at a time, at low priority and on two threads: this runs in the same
// container as the API, and a share link anyone can open must not be able to
// take the box. Uploaded files are untrusted, so the format is named and only
// local files may be opened.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import os from 'node:os';

const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_KEEP = 64 * 1024;

/** AIM4_FFMPEG, else the npm binary on a dev machine, else the system's (nixpacks.toml, Dockerfile). */
let binary = null;
async function ffmpegBinary() {
  if (process.env.AIM4_FFMPEG) return process.env.AIM4_FFMPEG;
  if (binary) return binary;
  try {
    binary = (await import('ffmpeg-static')).default || 'ffmpeg';
  } catch {
    binary = 'ffmpeg';
  }
  return binary;
}

let queue = Promise.resolve();
const oneAtATime = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

/** Run ffmpeg. Resolves with what it wrote to stderr, which is where it reports what it read. */
function ffmpeg(args) {
  return oneAtATime(
    async () => {
      const bin = await ffmpegBinary();
      return new Promise((resolve, reject) => {
        const child = spawn(bin, ['-hide_banner', '-nostdin', '-y', '-threads', '2', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        try {
          os.setPriority(child.pid, 10);
        } catch {
          /* it runs at normal priority, or already ended */
        }
        let err = '';
        child.stderr.on('data', (d) => {
          err = (err + d).slice(-STDERR_KEEP);
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), JOB_TIMEOUT_MS);
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e.code === 'ENOENT' ? new Error('ffmpeg is not installed on this server.') : e);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(err);
          else reject(new Error(`ffmpeg stopped (${code}): ${err.trim().split('\n').slice(-1)[0]?.slice(0, 200) || 'no message'}`));
        });
      });
    }
  );
}

const input = (format, file) => ['-protocol_whitelist', 'file', '-f', format, '-i', file];

/**
 * What a video file really holds, from ffmpeg's own report. Decodes every frame: only a decode counts them, and it shows the file really plays.
 *
 * @returns {Promise<{ codec: string, width: number, height: number, frames: number }>}
 */
export async function probeVideo(file) {
  const report = await ffmpeg([...input('mp4', file), '-map', '0:v:0', '-f', 'null', '-']);
  const stream = /Stream #0:\d+.*?: Video: (\w+).*?, (\d+)x(\d+)/.exec(report);
  if (!stream) throw new Error('That file has no video in it.');
  const frames = [...report.matchAll(/frame=\s*(\d+)/g)].pop();
  return { codec: stream[1], width: Number(stream[2]), height: Number(stream[3]), frames: frames ? Number(frames[1]) : 0 };
}

/** A GIF as an MP4. Near lossless: the picture was already cut to its palette, so no more is taken from it. */
export function gifToMp4(gif, out) {
  return ffmpeg([
    ...input('gif', gif),
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-an',
    '-f', 'mp4', out
  ]);
}

/** What a made GIF aims at. The clip keeps its full size; a GIF is for pasting, and 76 MB pastes nowhere. */
const GIF_TARGET_BYTES = 40 * 1024 * 1024;
/** Measured: a 3D clip of 145 frames at 1234 x 682 made 76 MB. */
const GIF_BYTES_PER_PIXEL = 0.66;

/** The width a clip's GIF is made at: its own, unless that would pass the target. */
export function gifWidthFor({ width, height, frames }) {
  const full = width * height * Math.max(1, frames) * GIF_BYTES_PER_PIXEL;
  return full <= GIF_TARGET_BYTES ? width : Math.round(width * Math.sqrt(GIF_TARGET_BYTES / full));
}

/**
 * An MP4 as a GIF: each frame its own palette (a moving camera changes every pixel) and an ordered
 * dither, which stays put between frames where error diffusion crawls.
 */
export async function mp4ToGif(mp4, out) {
  const video = await probeVideo(mp4);
  const width = gifWidthFor(video);
  const scale = width < video.width ? `scale=${width}:-1:flags=lanczos,` : '';
  return ffmpeg([
    ...input('mp4', mp4),
    '-lavfi', `${scale}split[a][b];[a]palettegen=stats_mode=single:reserve_transparent=0[p];[b][p]paletteuse=new=1:dither=bayer:bayer_scale=4`,
    '-loop', '0',
    '-f', 'gif', out
  ]);
}

/** The first frame, as the picture a link preview or a video that has not started shows. */
export function posterOf(mp4, out) {
  return ffmpeg([...input('mp4', mp4), '-frames:v', '1', '-q:v', '3', '-update', '1', '-f', 'image2', out]);
}
