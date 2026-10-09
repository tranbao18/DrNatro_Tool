// Ghi log ra màn hình và file logs/YYYY-MM-DD.log.
import fs from 'node:fs';
import path from 'node:path';
import { formatDateTime, dateKey } from './util.js';

export function createLogger({ rootDir, timeZone }) {
  const logDir = path.join(rootDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  function write(level, message, extra) {
    const now = new Date();
    const line = `[${formatDateTime(now, timeZone)}] [${level}] ${message}${extra ? ' ' + safeJson(extra) : ''}`;
    if (level === 'ERROR') console.error(line);
    else console.log(line);
    try {
      fs.appendFileSync(path.join(logDir, `${dateKey(now, timeZone)}.log`), line + '\n');
    } catch {
      // Không để lỗi ghi log làm dừng tool.
    }
  }

  return {
    info: (m, e) => write('INFO', m, e),
    warn: (m, e) => write('WARN', m, e),
    error: (m, e) => write('ERROR', m, e),
    debug: (m, e) => {
      if (process.env.DEBUG) write('DEBUG', m, e);
    },
  };
}

function safeJson(value) {
  try {
    if (value instanceof Error) return JSON.stringify({ message: value.message, stack: value.stack });
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
