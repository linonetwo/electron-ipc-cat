/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { IpcMain, ipcMain, IpcMainEvent, WebContents } from 'electron';
import { isObservable, Observable, Subscription } from 'rxjs';
import { serializeError } from 'serialize-error';
import { Worker } from 'worker_threads';
import {
  ApplyRequest,
  ApplySubscribeRequest,
  GetRequest,
  ProxyDescriptor,
  ProxyPropertyType,
  Request,
  RequestType,
  ResponseType,
  SubscribeRequest,
  UnsubscribeRequest,
} from './common.js';
import { IpcProxyError, isFunction } from './utilities.js';
import type { WorkerCallMessage, WorkerResponseMessage } from './worker.js';

// TODO: make it to be able to use @decorator, instead of write a description json. We can defer the setup of ipc handler to make this possible.
const registrations: Record<string, ProxyServerHandler | null> = {};

type ConsoleLogger = typeof console & {
  emerg: (message?: unknown) => void;
  alert: (message?: unknown) => void;
  crit: (message?: unknown) => void;
  warning: (message?: unknown) => void;
  notice: (message?: unknown) => void;
  debug: (message?: unknown) => void;
};

const _exampleLogger: ConsoleLogger = Object.assign(console, {
  emerg: console.error.bind(console),
  alert: console.error.bind(console),
  crit: console.error.bind(console),
  warning: console.warn.bind(console),
  notice: console.log.bind(console),
  debug: console.log.bind(console),
});

export function registerProxy(
  target: unknown,
  descriptor: ProxyDescriptor,
  transport: IpcMain = ipcMain,
  logger?: ConsoleLogger,
): VoidFunction {
  const { channel } = descriptor;

  // Check if channel is already registered (null or defined handler)
  if (registrations[channel]) {
    throw new IpcProxyError(`Proxy object has already been registered on channel ${channel}`);
  }

  const server = new ProxyServerHandler(target);
  registrations[channel] = server;

  // Also register for worker access
  workerProxyHandlers.set(channel, new ProxyServerHandler(target));
  workerProxyDescriptors.set(channel, descriptor);

  transport.on(channel, (event: IpcMainEvent, request: Request, correlationId: string) => {
    let sender: WebContents | undefined = event.sender;
    const nullify = (): void => {
      sender = undefined;
    };
    sender.once('destroyed', nullify);

    server
      .handleRequest(request, sender)
      .then((result) => {
        if (sender) {
          try {
            // Try to send the result directly first
            sender.send(correlationId, { type: ResponseType.Result, result });
            sender.removeListener('destroyed', nullify);
          } catch (serializationError) {
            // If Electron's structured clone fails, try to clean and resend
            const serializationErrorObject = serializationError as Error;
            if (logger?.error) {
              logger.error(`E-1 IPC Serialization Error on ${channel} ${request.type} ${serializationErrorObject.message}, attempting to clean result`);
            }

            try {
              // Attempt to clean the result via JSON serialization
              let cleanResult = result;
              if (result !== undefined) {
                cleanResult = JSON.parse(JSON.stringify(result));
              }
              sender.send(correlationId, { type: ResponseType.Result, result: cleanResult });
              sender.removeListener('destroyed', nullify);

              if (logger?.warning) {
                logger.warning(`Successfully sent cleaned result for ${channel} ${request.type}`);
              }
            } catch (cleanupError) {
              // If cleanup also fails, send error response
              const cleanupErrorObject = cleanupError as Error;
              if (logger?.error) {
                logger.error(`E-2 Failed to clean result on ${channel} ${request.type} ${cleanupErrorObject.message}`);
              }
              sender.send(correlationId, {
                type: ResponseType.Error,
                error: JSON.stringify(serializeError(
                  new Error(`Failed to serialize response: ${serializationErrorObject.message}`),
                  { maxDepth: 1 },
                )),
              });
              sender.removeListener('destroyed', nullify);
            }
          }
        }
      })
      .catch((error: unknown) => {
        if (sender) {
          let stringifiedRequest = '';
          try {
            stringifiedRequest = JSON.stringify(request);
          } catch {
            stringifiedRequest = request.type;
          }
          const errorObject = error as Error;
          const errorStack = errorObject.stack || '';
          if (logger?.error) {
            logger.error(`E-0 IPC Error on ${channel} ${stringifiedRequest} ${errorObject.message} ${errorStack}`);
          }
          sender.send(correlationId, { type: ResponseType.Error, error: JSON.stringify(serializeError(error, { maxDepth: 1 })) });
          sender.removeListener('destroyed', nullify);
        }
      });
  });

  return () => {
    unregisterProxy(channel, transport);
  };
}

function unregisterProxy(channel: string, transport: IpcMain): void {
  transport.removeAllListeners(channel);
  const server = registrations[channel];

  if (!server) {
    throw new IpcProxyError(`No proxy is registered on channel ${channel}`);
  }

  server.unsubscribeAll();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete registrations[channel];

  // Also clean up worker handler
  const workerHandler = workerProxyHandlers.get(channel);
  if (workerHandler) {
    workerHandler.unsubscribeAll();
  }
  workerProxyHandlers.delete(channel);
  workerProxyDescriptors.delete(channel);
}

class ProxyServerHandler {
  // Target must be any to support dynamic property access
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly target: any;

  constructor(target: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.target = target as any;
  }

  private subscriptions: Record<string, Subscription | undefined> = {};

  public async handleRequest(request: Request, sender: WebContents): Promise<unknown> {
    switch (request.type) {
      case RequestType.Get: {
        return await this.handleGet(request);
      }
      case RequestType.Apply: {
        return this.handleApply(request);
      }
      case RequestType.Subscribe: {
        this.handleSubscribe(request, sender);
        return;
      }
      case RequestType.ApplySubscribe: {
        this.handleApplySubscribe(request, sender);
        return;
      }
      case RequestType.Unsubscribe: {
        this.handleUnsubscribe(request);
        return;
      }
      default: {
        throw new IpcProxyError(`Unhandled RequestType [${request.type}]`);
      }
    }
  }

  public unsubscribeAll(): void {
    Object.values(this.subscriptions).forEach((subscription) => {
      if (subscription) {
        subscription.unsubscribe();
      }
    });
    this.subscriptions = {};
  }

  private async handleGet(request: GetRequest): Promise<unknown> {
    return this.target[request.propKey];
  }

  private handleApply(request: ApplyRequest): unknown {
    const { propKey, args } = request;
    const function_ = this.target[propKey];

    if (!isFunction(function_)) {
      throw new IpcProxyError(`Remote property [${propKey}] is not a function`);
    }

    return function_.apply(this.target, args);
  }

  private handleSubscribe(request: SubscribeRequest, sender: WebContents): void {
    const { propKey, subscriptionId } = request;
    const obs = this.target[propKey];

    if (!isObservable(obs)) {
      throw new IpcProxyError(`Remote property [${propKey}] is not an observable`);
    }
    if (typeof subscriptionId !== 'string') {
      // this will probably not happen
      throw new IpcProxyError(`subscriptionId [${subscriptionId as unknown as string}] is not a string`);
    }

    this.doSubscribe(obs, subscriptionId, sender);
  }

  private handleApplySubscribe(request: ApplySubscribeRequest, sender: WebContents): void {
    const { propKey, subscriptionId, args } = request;
    const function_ = this.target[propKey];

    if (!isFunction(function_)) {
      throw new IpcProxyError(`Remote property [${propKey}] is not a function`);
    }

    const obs = function_.apply(this.target, args);

    if (!isObservable(obs)) {
      throw new IpcProxyError(`Remote function [${propKey}] did not return an observable`);
    }
    if (typeof subscriptionId !== 'string') {
      throw new IpcProxyError(`subscriptionId [${subscriptionId as unknown as string}] is not a string`);
    }

    this.doSubscribe(obs, subscriptionId, sender);
  }

  private doSubscribe(obs: Observable<unknown>, subscriptionId: string, sender: WebContents): void {
    if (this.subscriptions[subscriptionId] !== undefined) {
      throw new IpcProxyError(`A subscription with Id [${subscriptionId}] already exists`);
    }

    this.subscriptions[subscriptionId] = obs.subscribe({
      next: (value: unknown) => {
        try {
          // Try to send the value directly first
          sender.send(subscriptionId, { type: ResponseType.Next, value });
        } catch (serializationError) {
          // If Electron's structured clone fails, try to clean and resend
          const serializationErrorObject = serializationError as Error;

          try {
            // Attempt to clean the value via JSON serialization
            let cleanValue = value;
            if (value !== undefined) {
              cleanValue = JSON.parse(JSON.stringify(value));
            }
            sender.send(subscriptionId, { type: ResponseType.Next, value: cleanValue });
          } catch {
            // If cleanup also fails, send error response
            sender.send(subscriptionId, {
              type: ResponseType.Error,
              error: JSON.stringify(serializeError(
                new Error(`Failed to serialize observable value: ${serializationErrorObject.message}`),
                { maxDepth: 1 },
              )),
            });
          }
        }
      },
      error: (error: Error) => {
        sender.send(subscriptionId, { type: ResponseType.Error, error: JSON.stringify(serializeError(error, { maxDepth: 1 })) });
      },
      complete: () => {
        sender.send(subscriptionId, { type: ResponseType.Complete });
      },
    });

    /*
     * If the sender does not clean up after itself then we need to do it
     *  This won't be called when webContent refresh by CMD+R, so beware this kind of memory leak.
     *  But we will try to detect devtools-reload-page
     */
    sender.once('destroyed', () => {
      this.doUnsubscribe(subscriptionId);
    });
    sender.once('devtools-reload-page', () => {
      this.doUnsubscribe(subscriptionId);
    });
  }

  private handleUnsubscribe(request: UnsubscribeRequest): void {
    const { subscriptionId } = request;

    if (this.subscriptions[subscriptionId] === undefined) {
      throw new IpcProxyError(`Subscription with Id [${subscriptionId}] does not exist`);
    }

    this.doUnsubscribe(subscriptionId);
  }

  private doUnsubscribe(subscriptionId: string): void {
    const subscription = this.subscriptions[subscriptionId];

    if (subscription !== undefined) {
      subscription.unsubscribe();
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this.subscriptions[subscriptionId];
    }
  }
}

/* ============================================================================
 * Worker Thread Support
 * ============================================================================ */

/**
 * Adapter to make Worker compatible with WebContents interface
 * This allows us to reuse ProxyServerHandler for worker threads
 */
class WorkerAdapter {
  constructor(
    private readonly worker: Worker,
    private readonly responseId: string,
  ) {}

  // Implement WebContents.send() interface
  send(channel: string, data: unknown): void {
    if (channel === this.responseId) {
      // Regular response
      const responseData = data as { type: ResponseType; result?: unknown; error?: string };
      if (responseData.type === ResponseType.Result) {
        try {
          // Try to send the result directly first
          this.worker.postMessage(
            {
              type: 'service-response',
              id: this.responseId,
              result: responseData.result,
            } satisfies WorkerResponseMessage,
          );
        } catch (serializationError) {
          // If structured clone fails, try to clean and resend
          const serializationErrorObject = serializationError as Error;

          try {
            // Attempt to clean the result via JSON serialization
            let cleanResult = responseData.result;
            if (cleanResult !== undefined) {
              cleanResult = JSON.parse(JSON.stringify(cleanResult));
            }
            this.worker.postMessage(
              {
                type: 'service-response',
                id: this.responseId,
                result: cleanResult,
              } satisfies WorkerResponseMessage,
            );
          } catch {
            // If cleanup also fails, send error response
            this.worker.postMessage(
              {
                type: 'service-response',
                id: this.responseId,
                error: {
                  message: `Failed to serialize response: ${serializationErrorObject.message}`,
                  name: 'SerializationError',
                  stack: serializationErrorObject.stack,
                },
              } satisfies WorkerResponseMessage,
            );
          }
        }
      } else if (responseData.type === ResponseType.Error && responseData.error) {
        const errorData = JSON.parse(responseData.error) as { message: string; name?: string; stack?: string };
        this.worker.postMessage(
          {
            type: 'service-response',
            id: this.responseId,
            error: {
              message: errorData.message,
              name: errorData.name,
              stack: errorData.stack,
            },
          } satisfies WorkerResponseMessage,
        );
      }
    } else {
      // Subscription response (channel is subscriptionId)
      const streamData = data as { type: ResponseType; value?: unknown; error?: string };
      if (streamData.type === ResponseType.Next) {
        try {
          // Try to send the value directly first
          this.worker.postMessage(
            {
              type: 'service-stream',
              id: this.responseId,
              result: streamData.value,
            } satisfies WorkerResponseMessage,
          );
        } catch (serializationError) {
          // If structured clone fails, try to clean and resend
          const serializationErrorObject = serializationError as Error;

          try {
            // Attempt to clean the value via JSON serialization
            let cleanValue = streamData.value;
            if (cleanValue !== undefined) {
              cleanValue = JSON.parse(JSON.stringify(cleanValue));
            }
            this.worker.postMessage(
              {
                type: 'service-stream',
                id: this.responseId,
                result: cleanValue,
              } satisfies WorkerResponseMessage,
            );
          } catch {
            // If cleanup also fails, send error response
            this.worker.postMessage(
              {
                type: 'service-stream',
                id: this.responseId,
                error: {
                  message: `Failed to serialize observable value: ${serializationErrorObject.message}`,
                  name: 'SerializationError',
                  stack: serializationErrorObject.stack,
                },
              } satisfies WorkerResponseMessage,
            );
          }
        }
      } else if (streamData.type === ResponseType.Error && streamData.error) {
        const errorData = JSON.parse(streamData.error) as { message: string; name?: string; stack?: string };
        this.worker.postMessage(
          {
            type: 'service-stream',
            id: this.responseId,
            error: {
              message: errorData.message,
              name: errorData.name,
              stack: errorData.stack,
            },
          } satisfies WorkerResponseMessage,
        );
      } else if (streamData.type === ResponseType.Complete) {
        this.worker.postMessage(
          {
            type: 'service-stream-complete',
            id: this.responseId,
          } satisfies WorkerResponseMessage,
        );
      }
    }
  }

  // Stub implementations for WebContents interface
  once(event: string, listener: () => void): void {
    if (event === 'destroyed') {
      this.worker.once('exit', listener);
    }
    // devtools-reload-page doesn't apply to workers
  }

  removeListener(event: string, listener: () => void): void {
    if (event === 'destroyed') {
      this.worker.removeListener('exit', listener);
    }
  }
}

/**
 * Registry for worker proxy handlers
 */
const workerProxyHandlers = new Map<string, ProxyServerHandler>();
const workerProxyDescriptors = new Map<string, ProxyDescriptor>();
const workerMessageHandlers = new WeakMap<Worker, boolean>();

/**
 * Attach a worker to existing registered services
 * Allows dynamically created workers to access all registered services
 *
 * @param worker Worker instance to attach
 * @returns Cleanup function
 *
 * @example
 * // First, register services
 * registerProxy(workspaceService, WorkspaceServiceIPCDescriptor);
 * registerProxy(authService, AuthServiceIPCDescriptor);
 *
 * // Later, when creating a new worker dynamically
 * const newWorker = new Worker('./worker.js');
 * attachWorker(newWorker);
 */
export function attachWorker(worker: Worker): VoidFunction {
  // Set up message listener if not already set
  if (workerMessageHandlers.has(worker)) {
    // Already attached
    return () => {};
  }

  workerMessageHandlers.set(worker, true);

  const messageHandler = async (message: unknown): Promise<void> => {
    if (typeof message === 'object' && message !== null && 'type' in message) {
      const typedMessage = message as WorkerCallMessage;
      // Handle service call messages from worker
      await handleWorkerServiceCall(worker, typedMessage);
    }
  };

  worker.on('message', messageHandler);

  // Cleanup on worker exit
  worker.once('exit', () => {
    workerMessageHandlers.delete(worker);
  });

  return () => {
    workerMessageHandlers.delete(worker);
    worker.removeListener('message', messageHandler);
  };
}

/**
 * Handle service call from worker using ProxyServerHandler
 */
async function handleWorkerServiceCall(
  worker: Worker,
  message: WorkerCallMessage,
): Promise<void> {
  const { id, service: channel, method, args: arguments_ = [], requestType, subscriptionId } = message;

  const handler = workerProxyHandlers.get(channel);
  const descriptor = workerProxyDescriptors.get(channel);

  if (!handler) {
    worker.postMessage(
      {
        type: 'service-response',
        id,
        error: {
          message: `Service '${channel}' not found`,
          name: 'ServiceNotFoundError',
        },
      } satisfies WorkerResponseMessage,
    );
    return;
  }

  // Create adapter to make Worker compatible with WebContents
  // We use type assertion here because WorkerAdapter implements the subset of WebContents we need
  const adapter = new WorkerAdapter(worker, id) as unknown as WebContents;

  let request: Request;

  if (requestType === RequestType.Unsubscribe) {
    const normalizedSubscriptionId = subscriptionId ?? id;
    request = {
      type: RequestType.Unsubscribe,
      subscriptionId: `${normalizedSubscriptionId}_sub`,
    } as UnsubscribeRequest;
  } else if (requestType === RequestType.Subscribe) {
    request = {
      type: RequestType.Subscribe,
      propKey: method,
      subscriptionId: `${id}_sub`,
    } as SubscribeRequest;
  } else if (requestType === RequestType.ApplySubscribe) {
    request = {
      type: RequestType.ApplySubscribe,
      propKey: method,
      subscriptionId: `${id}_sub`,
      args: arguments_,
    } as ApplySubscribeRequest;
  } else if (requestType === RequestType.Get) {
    request = {
      type: RequestType.Get,
      propKey: method,
    } as GetRequest;
  } else if (requestType === RequestType.Apply) {
    request = {
      type: RequestType.Apply,
      propKey: method,
      args: arguments_,
    } as ApplyRequest;
  } else {
    // Determine the correct request type based on descriptor as fallback
    const propertyType = descriptor?.properties[method];

    if (propertyType === ProxyPropertyType.Value$) {
      request = {
        type: RequestType.Subscribe,
        propKey: method,
        subscriptionId: `${id}_sub`,
      } as SubscribeRequest;
    } else if (propertyType === ProxyPropertyType.Function$) {
      request = {
        type: RequestType.ApplySubscribe,
        propKey: method,
        subscriptionId: `${id}_sub`,
        args: arguments_,
      } as ApplySubscribeRequest;
    } else if (propertyType === ProxyPropertyType.Value) {
      request = {
        type: RequestType.Get,
        propKey: method,
      } as GetRequest;
    } else {
      request = {
        type: RequestType.Apply,
        propKey: method,
        args: arguments_,
      } as ApplyRequest;
    }
  }

  try {
    const result = await handler.handleRequest(request, adapter);

    // Always send response, even for void/undefined results
    // This ensures the client doesn't wait forever
    adapter.send(id, { type: ResponseType.Result, result });
  } catch (error) {
    const error_ = error as Error;
    adapter.send(id, {
      type: ResponseType.Error,
      error: JSON.stringify(serializeError(error_, { maxDepth: 1 })),
    });
  }
}

export type { ProxyDescriptor, ProxyPropertyType } from './common';
