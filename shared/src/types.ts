export interface SourceRef {
  id: string;
  title: string;
  url: string;
}

export interface Author {
  name: string;
  id: string;
}

export interface CaptureRecord {
  id: string;
  connection: string;
  connectionVersion: string;
  kind: string;
  source: SourceRef;
  position: number | null;
  occurredAt: string;
  capturedAt: string;
  author: Author | null;
  text: string;
  fields: { [key: string]: unknown };
  revision: number;
  deleted: boolean;
}

export interface Coverage {
  sourceId: string;
  expected: number | null;
  have: number;
  gaps: Array<[number, number]>;
  complete: boolean;
  reason: string | null;
  updatedAt: string;
}

export interface ConnectionManifest {
  id: string;
  version: string;
  title: string;
  sites: Array<{ match: string; frames?: boolean }>;
  kinds: string[];
  fields?: { [key: string]: string };
  pace: {
    reveal: boolean;
    loadBudget: number | null;
    hourlyLoadBudget?: number;
    oldestDays?: number;
  };
  defaults: { enabled: boolean };
  risks: string[];
}

export interface PageSnapshot {
  sourceId: string | null;
  title: string;
  url: string;
  count: number;
  coverage: string;
  error: string | null;
  skipped: string | null;
}
