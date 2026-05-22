declare module 'swagger2openapi' {
  export interface ConvertOptions {
    patch?: boolean;
    warnOnly?: boolean;
    [key: string]: unknown;
  }

  export interface ConvertResult {
    openapi?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export function convertObj(
    swagger: Record<string, unknown>,
    options: ConvertOptions,
    callback: (err: unknown, options: ConvertResult) => void,
  ): void;

  const swagger2openapi: {
    convertObj: typeof convertObj;
  };

  export default swagger2openapi;
}
