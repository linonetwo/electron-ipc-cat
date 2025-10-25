/* Custom Error */
export class IpcProxyError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/* Utils */
export function isFunction(value: unknown): value is (...arguments_: unknown[]) => unknown {
  return value !== undefined && typeof value === 'function';
}

/**
 * Fix ContextIsolation
 * @param key original key
 * @returns
 */
export function getSubscriptionKey(key: string): string {
  return `${key}Subscribe`;
}
