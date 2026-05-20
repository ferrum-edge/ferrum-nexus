import pino, { type Logger } from 'pino';

export interface LoggerOptions {
  level: string;
  transport?: {
    target: string;
    options: Record<string, unknown>;
  };
  redact: { paths: string[]; remove: boolean };
}

export function loggerConfig(env: string): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? (env === 'production' ? 'info' : 'debug'),
    transport:
      env === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'password_hash', '*.password'],
      remove: true,
    },
  };
}

export function createLogger(env: string): Logger {
  return pino(loggerConfig(env));
}
