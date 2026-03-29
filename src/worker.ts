/**
 * Worker-side proxy creator for calling main process services
 * Similar to client.ts but for Node.js worker threads
 */

import memoize from 'memize';
import type { Observer, Subscribable, TeardownLogic } from 'rxjs';
import { addKnownErrorConstructor, deserializeError } from 'serialize-error';
import { parentPort } from 'worker_threads';
import { type ProxyDescriptor, ProxyPropertyType, Request, RequestType, type UnsubscribeRequest } from './common.js';
import { IpcProxyError } from './utilities.js';

export type ObservableConstructor = new(subscribe: (obs: Observer<unknown>) => TeardownLogic) => Subscribable<unknown>;

// Register error constructor for serialization (with error handling for duplicate registration)
try {
  addKnownErrorConstructor(IpcProxyError);
} catch {
  // Already registered
}

// Message types for worker IPC
export interface WorkerCallMessage {
  type: 'service-call';
  id: string;
  service: string;
  method: string;
  args: unknown[];
  requestType?: RequestType;
  subscriptionId?: string;
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
  removeAllListeners?(channel: string): void;
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
    postMessage: (message: WorkerCallMessage) => {
      port.postMessage(message);
    },
    on: (event: string, handler: (message: WorkerResponseMessage) => void) => {
      if (event === 'message') {
        port.on('message', handler);
      }
    },
    removeAllListeners: (channel: string) => {
      port.removeAllListeners(channel);
    },
  };
}

// Per-transport state to avoid global state pollution
const transportStates = new WeakMap<WorkerTransport, {
  initialized: boolean;
  pendingCalls: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  pendingStreams: Map<string, { next: (value: unknown) => void; error: (error: Error) => void; complete: () => void }>;
}>();

function getTransportState(transport: WorkerTransport) {
  let state = transportStates.get(transport);
  if (!state) {
    state = {
      initialized: false,
      pendingCalls: new Map(),
      pendingStreams: new Map(),
    };
    transportStates.set(transport, state);
  }
  return state;
}

/**
 * Initialize worker transport message handler
 */
function initializeTransport(transport: WorkerTransport): void {
  const state = getTransportState(transport);
  if (state.initialized) {
    return;
  }

  transport.on('message', (message: WorkerResponseMessage) => {
    const { id, type, result, error: errorData } = message;

    if (type === 'service-response') {
      const pending = state.pendingCalls.get(id);
      if (!pending) return;

      if (errorData) {
        const error = new Error(errorData.message);
        error.name = errorData.name ?? 'ServiceCallError';
        error.stack = errorData.stack;
        pending.reject(deserializeError(error));
      } else {
        pending.resolve(result);
      }
      state.pendingCalls.delete(id);
    } else if (type === 'service-stream') {
      const pending = state.pendingStreams.get(id);
      if (!pending) return;

      if (errorData) {
        const error = new Error(errorData.message);
        error.name = errorData.name ?? 'ServiceStreamError';
        error.stack = errorData.stack;
        pending.error(deserializeError(error));
        state.pendingStreams.delete(id);
      } else {
        pending.next(result);
      }
      // Handle stream completion - this is a runtime check despite type narrowing
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (type === 'service-stream-complete') {
      const pending = state.pendingStreams.get(id);
      if (!pending) return;

      pending.complete();
      state.pendingStreams.delete(id);
    }
  });

  state.initialized = true;
}

/**
 * Make a request to the main process
 */
function makeRequest(
  request: Request,
  channel: string,
  transport: WorkerTransport,
): Promise<unknown> {
  const state = getTransportState(transport);

  if (!state.initialized) {
    initializeTransport(transport);
  }

  const id = String(Math.random());
  const propertyKey = 'propKey' in request ? request.propKey : '';
  const requestType = request.type === 'unknown' ? undefined : request.type;
  const subscriptionId = 'subscriptionId' in request ? request.subscriptionId : undefined;

  return new Promise((resolve, reject) => {
    state.pendingCalls.set(id, { resolve, reject });

    transport.postMessage({
      type: 'service-call',
      id,
      service: channel,
      method: String(propertyKey),
      args: 'args' in request && Array.isArray(request.args) ? request.args : [],
      requestType,
      subscriptionId,
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (state.pendingCalls.has(id)) {
        state.pendingCalls.delete(id);
        reject(new Error(`Service call timeout: ${channel}.${String(propertyKey)}`));
      }
    }, 30_000);
  });
}

/**
 * Create an Observable for streaming responses
 */
function makeObservable(
  request: Request,
  channel: string,
  ObservableCtor: ObservableConstructor,
  transport: WorkerTransport,
): Subscribable<unknown> {
  const state = getTransportState(transport);

  if (!state.initialized) {
    initializeTransport(transport);
  }

  const propertyKey = 'propKey' in request ? request.propKey : 'unknown';

  return new ObservableCtor((observer) => {
    const subscriptionId = String(Math.random());
    // subscriptionRequest is used as a placeholder for future expansion
    const _subscriptionRequest = { ...request, subscriptionId };

    const onComplete = () => {
      // Unsubscribe from remote
      makeRequest({ type: RequestType.Unsubscribe, subscriptionId } as UnsubscribeRequest, channel, transport).catch((error: unknown) => {
        console.log('Error unsubscribing from remote observable', error);
        observer.error(error);
      });

      // Clean up local state
      state.pendingStreams.delete(subscriptionId);

      // Remove transport listener if available
      transport.removeAllListeners?.(subscriptionId);
    };

    state.pendingStreams.set(subscriptionId, {
      next: (value: unknown) => {
        observer.next(value);
      },
      error: (error: Error) => {
        observer.error(error);
        state.pendingStreams.delete(subscriptionId);
      },
      complete: () => {
        observer.complete();
        state.pendingStreams.delete(subscriptionId);
      },
    });

    // Send subscription request
    transport.postMessage({
      type: 'service-call',
      id: subscriptionId,
      service: channel,
      method: String(propertyKey),
      args: 'args' in request && Array.isArray(request.args) ? request.args : [],
      requestType: request.type === 'unknown' ? undefined : request.type,
      subscriptionId,
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (state.pendingStreams.has(subscriptionId)) {
        const pending = state.pendingStreams.get(subscriptionId);
        state.pendingStreams.delete(subscriptionId);
        pending?.error(new Error(`Service call timeout: ${channel}.${String(propertyKey)}`));
      }
    }, 30_000);

    return onComplete;
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
): Promise<unknown> | Subscribable<unknown> | ((...arguments_: unknown[]) => Promise<unknown>) | ((...arguments_: unknown[]) => Subscribable<unknown>) {
  switch (propertyType) {
    case ProxyPropertyType.Value: {
      return makeRequest({ type: RequestType.Get, propKey: propertyKey }, channel, transport);
    }
    case ProxyPropertyType.Value$: {
      return makeObservable({ type: RequestType.Subscribe, propKey: propertyKey }, channel, ObservableCtor, transport);
    }
    case ProxyPropertyType.Function: {
      return async (...arguments_: unknown[]) => await makeRequest({ type: RequestType.Apply, propKey: propertyKey, args: arguments_ }, channel, transport);
    }
    case ProxyPropertyType.Function$: {
      return (...arguments_: unknown[]) => makeObservable({ type: RequestType.ApplySubscribe, propKey: propertyKey, args: arguments_ }, channel, ObservableCtor, transport);
    }
    default: {
      throw new IpcProxyError(`Unknown property type: ${propertyType as string}`);
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
// T is used in the return type to provide proper typing for the proxy
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
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
      get: memoize(() => getProperty(propertyType, propertyKey, channel, ObservableCtor, transport)),
    });
  });

  return result as T;
}

/**
 * Type helper to convert service methods to worker-compatible types
 */
export type WorkerProxy<T> = {
  [K in keyof T]: T[K] extends (...arguments_: infer A) => Subscribable<infer R> ? (...arguments_: A) => Subscribable<R>
    : T[K] extends (...arguments_: infer A) => infer R ? (...arguments_: A) => Promise<Awaited<R>>
    : T[K] extends Subscribable<infer R> ? Subscribable<R>
    : Promise<Awaited<T[K]>>;
};

export type { ProxyDescriptor, ProxyPropertyType } from './common.js';
