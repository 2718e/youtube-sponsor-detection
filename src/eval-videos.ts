// The list of labelled videos the eval scores, and where their transcripts live.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Cue } from './transcript.js';

export const VIDEO_FILES = ['eval/videos.seed.json', 'eval/videos.json'];

export interface EvalSegment {
  start: number;
  end: number;
  votes?: number;
  locked?: boolean;
}

export interface EvalVideo {
  videoID: string;
  duration?: number | null;
  segments: EvalSegment[];
}

export interface SavedTranscript {
  title: string;
  cues: Cue[];
  route: string;
}

/** Seed videos first, then the sampled ones, without duplicates. */
export async function evalVideos(): Promise<EvalVideo[]> {
  const videos: EvalVideo[] = [];
  for (const file of VIDEO_FILES) {
    if (!existsSync(file)) continue;
    const data = JSON.parse(await readFile(file, 'utf8'));
    for (const v of data.videos) if (!videos.some((x) => x.videoID === v.videoID)) videos.push(v);
  }
  return videos;
}

export function transcriptFile(videoID: string): string {
  return `eval/transcripts/${videoID}.json`;
}

/** A saved transcript, or null when it has not been saved yet. */
export async function savedTranscript(videoID: string): Promise<SavedTranscript | null> {
  const file = transcriptFile(videoID);
  if (!existsSync(file)) return null;
  const { title, cues, route } = JSON.parse(await readFile(file, 'utf8'));
  return { title, cues, route: `saved/${route}` };
}
