import { pino } from 'pino';
import { createLogger, type Logger } from '../src/logger.js';

export const silentLogger = createLogger('silent');

// A logger whose output can be inspected, e.g. to prove that secrets never reach the logs.
export function captureLogger(): { logger: Logger; output: () => string } {
  const lines: string[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
  return { logger, output: () => lines.join('') };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
