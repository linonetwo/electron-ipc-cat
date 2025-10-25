/**
 * Worker-side proxy creator for calling main process services
 * Similar to client.ts but for Node.js worker threads
 */

import { parentPort } from 'worker_threads';
import type { Observable } from 'rxjs';
import { type ProxyDescriptor, ProxyPropertyType } from './common.js';

export type ObservableConstructor = new(subscribe: (obs: any) => any) => Observable<any>;

// Message types for worker IPC
export interface WorkerCallMessage {
  type: 'service-call';
  id: string;
  service: string;
  method: string;
  args: unknown[];
}

export interface WorkerResponseMessage {
  type: 'service-response' | 'service-stream' | 'service-stream-complete';
  id: string;
  result?: unknown;
  error?: {
    message: string;
    name?: string;
    stack?: string;
  };
}

/**
 * Transport interface for worker thread communication
 */
export interface WorkerTransport {
  postMessage(message: WorkerCallMessage): void;
  on(event: 'message', handler: (message: WorkerResponseMessage) => void): void;
}

/**
 * Default transport using Node.js worker_threads parentPort
 */
export function createDefaultWorkerTransport(): WorkerTransport {
  if (!parentPort) {
    throw new Error('parentPort is not available. Must be called in a worker thread.');
  }

  // Cache parentPort reference since we've already checked it's not null
  const port = parentPort;

  return {
    postMessage: (message: WorkerCallMessage) => port.postMessage(message),
    on: (event: string, handler: (message: WorkerResponseMessage) => void) => {
      if (event === 'message') {
        port.on('message', handler);
      }
    },
  };
}

const pendingCalls = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>();

const pendingStreams = new Map<string, {
  next: (value: unknown) => void;
  error: (error: Error) => void;
  complete: () => void;
}>();

/**
 * Initialize worker transport message handler
 */
function initializeTransport(transport: WorkerTransport): void {
  transport.on('message', (message: WorkerResponseMessage) => {
    const { id, type, result, error: errorData } = message;

    if (type === 'service-response') {
      const pending = pendingCalls.get(id);
      if (!pending) return;

      if (errorData) {
        const error = new Error(errorData.message);
        error.name = errorData.name ?? 'ServiceCallError';
        error.stack = errorData.stack;
        pending.reject(error);
      } else {
        pending.resolve(result);
      }
      pendingCalls.delete(id);
    } else if (type === 'service-stream') {
      const pending = pendingStreams.get(id);
      if (!pending) return;

      if (errorData) {
        const error = new Error(errorData.message);
        error.name = errorData.name ?? 'ServiceStreamError';
        error.stack = errorData.stack;
        pending.error(error);
        pendingStreams.delete(id);
      } else {
        pending.next(result);
      }
    } else if (type === 'service-stream-complete') {
      const pending = pendingStreams.get(id);
      if (!pending) return;

      pending.complete();
      pendingStreams.delete(id);
    }
  });
}

let transportInitialized = false;

/**
 * Call a service method and return a Promise
 */
function callService(
  channel: string,
  methodName: string,
  arguments_: unknown[],
  transport: WorkerTransport,
): Promise<unknown> {
  if (!transportInitialized) {
    initializeTransport(transport);
    transportInitialized = true;
  }

  const id = `${channel}_${methodName}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject });

    transport.postMessage({
      type: 'service-call',
      id,
      service: channel,
      method: methodName,
      args: arguments_,
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingCalls.has(id)) {
        pendingCalls.delete(id);
        reject(new Error(`Service call timeout: ${channel}.${methodName}`));
      }
    }, 30_000);
  });
}

/**
 * Call a service method and return an Observable
 */
function callServiceObservable(
  channel: string,
  methodName: string,
  arguments_: unknown[],
  ObservableCtor: ObservableConstructor,
  transport: WorkerTransport,
): Observable<unknown> {
  if (!transportInitialized) {
    initializeTransport(transport);
    transportInitialized = true;
  }

  const id = `${channel}_${methodName}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return new ObservableCtor((observer) => {
    pendingStreams.set(id, {
      next: (value: unknown) => observer.next(value),
      error: (error: Error) => observer.error(error),
      complete: () => observer.complete(),
    });

    transport.postMessage({
      type: 'service-call',
      id,
      service: channel,
      method: methodName,
      args: arguments_,
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingStreams.has(id)) {
        const pending = pendingStreams.get(id);
        pendingStreams.delete(id);
        pending?.error(new Error(`Service call timeout: ${channel}.${methodName}`));
      }
    }, 30_000);

    return () => {
      pendingStreams.delete(id);
    };
  });
}

/**
 * Create a proxy for a specific property
 */
function getProperty(
  propertyType: ProxyPropertyType,
  propertyKey: string,
  channel: string,
  ObservableCtor: ObservableConstructor,
  transport: WorkerTransport,
): Promise<any> | Observable<any> | ((...arguments_: any[]) => Promise<any>) | ((...arguments_: any[]) => Observable<any>) {
  switch (propertyType) {
    case ProxyPropertyType.Value: {
      return callService(channel, propertyKey, [], transport);
    }
    case ProxyPropertyType.Value$: {
      return callServiceObservable(channel, propertyKey, [], ObservableCtor, transport);
    }
    case ProxyPropertyType.Function: {
      return async (...arguments_: unknown[]) => await callService(channel, propertyKey, arguments_, transport);
    }
    case ProxyPropertyType.Function$: {
      return (...arguments_: unknown[]) => callServiceObservable(channel, propertyKey, arguments_, ObservableCtor, transport);
    }
    default: {
      throw new Error(`Unknown property type: ${propertyType as string}`);
    }
  }
}

/**
 * Create a typed proxy for worker thread to call main process services
 *
 * @param descriptor Service descriptor defining channel and property types
 * @param ObservableCtor Observable constructor (e.g., from rxjs)
 * @param transport Worker transport (defaults to parentPort)
 * @returns Typed proxy object
 *
 * @example
 * // In worker thread
 * import { createWorkerProxy } from 'electron-ipc-cat/worker';
 * import { Observable } from 'rxjs';
 *
 * const workspace = createWorkerProxy<WorkerProxy<IWorkspaceService>>(
 *   WorkspaceServiceIPCDescriptor,
 *   Observable
 * );
 *
 * const workspaces = await workspace.getWorkspacesAsList();
 * workspace.get$(id).subscribe(ws => console.log(ws));
 */
export function createWorkerProxy<T>(
  descriptor: ProxyDescriptor,
  ObservableCtor: ObservableConstructor,
  transport: WorkerTransport = createDefaultWorkerTransport(),
): T {
  const { channel, properties } = descriptor;

  const result: Record<string, unknown> = {};

  Object.keys(properties).forEach((propertyKey) => {
    const propertyType = properties[propertyKey];

    // Validate Observable constructor for Observable types
    if ((propertyType === ProxyPropertyType.Value$ || propertyType === ProxyPropertyType.Function$) && typeof ObservableCtor !== 'function') {
      throw new Error(
        'You must provide an Observable constructor for Observable proxy properties',
      );
    }

    Object.defineProperty(result, propertyKey, {
      enumerable: true,
      get: () => getProperty(propertyType, propertyKey, channel, ObservableCtor, transport),
    });
  });

  return result as T;
}

/**
 * Type helper to convert service methods to worker-compatible types
 */
export type WorkerProxy<T> = {
  [K in keyof T]: T[K] extends (...arguments_: infer A) => Observable<infer R> ? (...arguments_: A) => Observable<R>
    : T[K] extends (...arguments_: infer A) => infer R ? (...arguments_: A) => Promise<Awaited<R>>
    : T[K] extends Observable<infer R> ? Observable<R>
    : Promise<Awaited<T[K]>>;
};

export type { ProxyDescriptor, ProxyPropertyType } from './common.js';
