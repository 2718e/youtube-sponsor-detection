// The shapes that cross module boundaries: the client a run drives, the
// question-answering plumbing, what a scan produces, and what a run reports.

import { type Line } from '../transcript.js';
import {
  type CanonicalRequest,
  type ProviderAnswer,
  type Questions,
  type Usage
} from '../providers/contract.js';
import { type Thresholds } from './thresholds.js';

/** A client the pipeline can drive: the provider contract's one method. */
export interface PipelineClient {
  systemOne(request: CanonicalRequest): Promise<ProviderAnswer>;
}

export interface ProgressEvent {
  stage: string;
  [key: string]: unknown;
}

/** One scan request's answer, plus the window it came from. */
export interface Scan {
  index: number;
  lines: Line[];
  from: number;
  to: number;
  presence: number;
  pNone: number;
  startLineId: string | null;
  startLineProbability: number;
  estimatedStateTokens: number;
}

/** A scan without its transcript lines: what the result reports as `windows`. */
export interface ScanWindow extends Omit<Scan, 'lines'> {
  fromTimestamp?: string;
  toTimestamp?: string;
}

export interface PhraseCut {
  id: string;
  text: string;
  start: number;
  end: number;
  probability: number;
}

export interface SegmentBoundary {
  lineId: string;
  seconds: number;
  lineSeconds: number;
  text: string;
  probability: number;
  phrase: PhraseCut | null;
  runsPastExcerpt?: number;
  timestamp?: string;
}

export interface SegmentAnchor {
  lineId: string;
  seconds: number;
  text: string;
  probability: number;
}

export interface SponsorSegment {
  confidence: number;
  scanPresence: number;
  refinePresence: number;
  start: SegmentBoundary;
  anchor: SegmentAnchor;
  end: SegmentBoundary | null;
  lineIds: string[];
  context: Line[];
}

export type SponsorStatus = 'found' | 'uncertain' | 'not-found' | 'no-transcript';

export interface SponsorResult {
  status: SponsorStatus;
  confidence: number;
  start: SegmentBoundary | null;
  end: SegmentBoundary | null;
  context: Line[];
  segments: SponsorSegment[];
  windows: ScanWindow[];
  usage: Usage;
}

export type Ask = (state: Record<string, unknown>, questions: Questions) => Promise<ProviderAnswer>;
export type Report = (event: ProgressEvent) => void;

export interface FindOptions {
  client: PipelineClient;
  model?: string;
  title?: string;
  thresholds?: Partial<Thresholds>;
  onProgress?: Report;
}
