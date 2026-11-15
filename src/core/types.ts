export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  message: string;
  line?: number;
  column?: number;
  hint?: string;
}

export interface Repair {
  phase: 'source' | 'compile' | 'runtime' | 'render';
  title: string;
  detail?: string;
  line?: number;
}

export interface ConsoleEvent {
  kind: 'line' | 'clear';
  text?: string;
}
