/**
 * Main-process → UtilityProcess RPC proxy.
 *
 * `electron-ipc-cat` provides two directions of communication:
 * - `worker.ts` / `client.ts`: child process calls main-process services
 * - `host.ts` (this file): main process calls child-process (UtilityProcess) methods
 *
 * Together they form a complete bidirectional RPC layer between the Electron
 * main process and its UtilityProcess children.
 *
 * @module electron-ipc-cat/host
 */

import { Observable, Subject } from 'rxjs';

export interface WorkerMessage<T = unknown> {
  type: 'call' | 'response' | 'error' | 'stream' | 'complete';
  id?: string;
  method?: string;
  args?: unknown[];
  result?: T;
  error?: {
    message: string;
    stack?: string;
    name?: string;
  };
}

/**
 * Minimal peer interface satisfied by Electron `UtilityProcess`.
 * Used by `createWorkerMethodProxy` on the main-process side to send/receive
 * RPC messages.
 */
export interface WorkerPeer {
  postMessage(message: unknown): void;
  on(event: 'message', handler: (message: unknown) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  on(event: 'exit', handler: (code: number) => void): void;
}

/**
 * Create a proxy that calls methods on a UtilityProcess child.
 *
 * The returned proxy mimics the worker's method signatures: each method call
 * is serialized and sent via `postMessage`; the response (or Observable stream)
 * is resolved when the child replies.
 *
 * @example
 * ```ts
 * import { createWorkerMethodProxy } from 'electron-ipc-cat/host';
 * const child = utilityProcess.fork(workerPath);
 * const proxy = createWorkerMethodProxy<MyWorkerType>(child);
 * await proxy.someMethod(arg1, arg2);
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-type-parameters -- T is needed to provide type safety for the returned proxy object
export function createWorkerMethodProxy<T extends Record<string, (...arguments_: any[]) => any>>(
  peer: WorkerPeer,
): T {
  const pendingCalls = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    subject?: Subject<unknown>;
  }>();

  peer.on('message', (rawMessage: unknown) => {
    const message = rawMessage as WorkerMessage;
    const pending = pendingCalls.get(message.id!);
    if (!pending) return;

    switch (message.type) {
      case 'response': {
        pending.resolve(message.result);
        pendingCalls.delete(message.id!);
        break;
      }
      case 'error': {
        const error = new Error(message.error!.message);
        error.name = message.error!.name || 'WorkerError';
        error.stack = message.error!.stack;
        pending.reject(error);
        pendingCalls.delete(message.id!);
        break;
      }
      case 'stream':
        if (pending.subject) {
          pending.subject.next(message.result);
        }
        break;
      case 'complete':
        if (pending.subject) {
          pending.subject.complete();
          pendingCalls.delete(message.id!);
        }
        break;
    }
  });

  const rejectAll = (error: Error): void => {
    for (const [id, pending] of pendingCalls.entries()) {
      pending.reject(error);
      if (pending.subject) {
        pending.subject.error(error);
      }
      pendingCalls.delete(id);
    }
  };

  peer.on('error', (error: unknown) => {
    const error_ = error instanceof Error ? error : new Error(String(error));
    rejectAll(error_);
  });

  peer.on('exit', (code: number) => {
    if (code !== 0) {
      rejectAll(new Error(`Peer process exited with code ${code}`));
    }
  });

  return new Proxy({} as T, {
    get: (_target, method: string | symbol) => {
      if (method === 'then' || method === 'catch' || method === 'finally') {
        return undefined;
      }

      if (typeof method === 'symbol') {
        return undefined;
      }

      return (...arguments_: unknown[]) => {
        const id = `${method}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        const isObservable = method.includes('init') || method.includes('sync') || method.includes('commit') ||
          method.includes('start') || method.includes('clone') || method.includes('force') ||
          method.includes('execute') || method.toLowerCase().includes('observer');

        const serializedArguments = arguments_.map((argument) => {
          try {
            return structuredClone(argument);
          } catch {
            return argument;
          }
        });

        if (isObservable) {
          return new Observable((observer) => {
            const subject = new Subject();
            subject.subscribe(observer);

            pendingCalls.set(id, {
              resolve: () => {},
              reject: (error) => {
                subject.error(error);
              },
              subject,
            });

            peer.postMessage({
              type: 'call',
              id,
              method,
              args: serializedArguments,
            });

            return () => {
              pendingCalls.delete(id);
            };
          });
        } else {
          return new Promise((resolve, reject) => {
            pendingCalls.set(id, { resolve, reject });

            peer.postMessage({
              type: 'call',
              id,
              method,
              args: serializedArguments,
            });
          });
        }
      };
    },
  });
}

/**
 * Message port interface for the child side (utility process).
 */
interface MessagePortLike {
  postMessage(message: unknown): void;
  on(event: 'message', handler: (message: unknown) => void): void;
}

/**
 * Core message handler for utility process children.
 * Each message spawns an async handler — callers are responsible for
 * serialization if interleaving must be avoided (e.g. per-repo git locks).
 */
function handleMessages(
  methods: Record<string, (...arguments_: unknown[]) => unknown>,
  port: MessagePortLike,
): void {
  port.on('message', async (rawMessage: unknown) => {
    const message = rawMessage as WorkerMessage;
    const { id, method, args, type } = message;

    if (type !== 'call' || !method) return;

    const implementation = methods[method];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime lookup may return undefined even though Record type says otherwise
    if (!implementation) {
      port.postMessage(
        {
          type: 'error',
          id,
          error: {
            message: `Method '${method}' not found in worker`,
            name: 'MethodNotFoundError',
          },
        } satisfies WorkerMessage,
      );
      return;
    }

    try {
      const result: unknown = implementation(...(args || []));
      if (result && typeof result === 'object' && 'subscribe' in result && typeof result.subscribe === 'function') {
        (result as Observable<unknown>).subscribe({
          next: (value: unknown) => {
            port.postMessage(
              {
                type: 'stream',
                id,
                result: value,
              } satisfies WorkerMessage,
            );
          },
          error: (error: Error) => {
            port.postMessage(
              {
                type: 'error',
                id,
                error: {
                  message: error.message,
                  stack: error.stack,
                  name: error.name,
                },
              } satisfies WorkerMessage,
            );
          },
          complete: () => {
            port.postMessage(
              {
                type: 'complete',
                id,
              } satisfies WorkerMessage,
            );
          },
        });
      } else if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
        const resolvedValue = await (result as Promise<unknown>);
        port.postMessage(
          {
            type: 'response',
            id,
            result: resolvedValue,
          } satisfies WorkerMessage,
        );
      } else {
        port.postMessage(
          {
            type: 'response',
            id,
            result,
          } satisfies WorkerMessage,
        );
      }
    } catch (error) {
      const error_ = error as Error;
      port.postMessage(
        {
          type: 'error',
          id,
          error: {
            message: error_.message,
            stack: error_.stack,
            name: error_.name,
          },
        } satisfies WorkerMessage,
      );
    }
  });
}

/**
 * Utility-process-side message handler.
 * Uses `process.parentPort` from Electron (messages arrive wrapped in
 * `{ data, ports }` event objects, so we unwrap `event.data`).
 *
 * @example
 * ```ts
 * // In your utility process entry file:
 * import { handleUtilityProcessMessages } from 'electron-ipc-cat/host';
 * handleUtilityProcessMessages({ methodName: implementation });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handleUtilityProcessMessages(methods: Record<string, (...arguments_: any[]) => any>): void {
  const port = (process as { parentPort?: MessagePortLike }).parentPort;

  if (!port) {
    throw new Error('This function must be called in an Electron utility process');
  }

  handleMessages(methods, {
    postMessage: (message: unknown) => {
      port.postMessage(message);
    },
    on: (event, handler) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guard against future event types
      if (event === 'message') {
        (port as { on(event_: string, handler_: (...arguments_: unknown[]) => void): void }).on(event, (event_: unknown) => {
          handler((event_ as { data: WorkerMessage }).data);
        });
      }
    },
  });
}

/**
 * Terminate a utility process gracefully.
 */
export async function terminateWorker(peer: { terminate(): Promise<number> } | { kill(): boolean }): Promise<number> {
  if ('terminate' in peer) {
    return await peer.terminate();
  }
  return peer.kill() ? 0 : 1;
}
