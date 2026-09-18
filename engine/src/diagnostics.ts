export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  line: number;
  col: number;
}

export const diag = (severity: Severity, code: string, message: string, line: number, col: number): Diagnostic =>
  ({ severity, code, message, line, col });
