/* eslint-disable @typescript-eslint/require-await */

/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { IpcMain, ipcMain, IpcMainEvent, WebContents } from 'electron';
import { Worker } from 'worker_threads';
import { isObservable, Observable, Subscription } from 'rxjs';
import { serializeError } from 'serialize-error';
import { ApplyRequest, ApplySubscribeRequest, GetRequest, ProxyDescriptor, ProxyPropertyType, Request, RequestType, ResponseType, SubscribeRequest, UnsubscribeRequest } from './common.js';
import { IpcProxyError, isFunction } from './utilities.js';
import type { WorkerCallMessage, WorkerResponseMessage } from './worker.js';

// TODO: make it to be able to use @decorator, instead of write a description json. We can defer the setup of ipc handler to make this possible.
const registrations: Record<string, ProxyServerHandler | null> = {};

const exampleLogger = Object.assign(console, {
  emerg: console.error.bind(console),
  alert: console.error.bind(console),
  crit: console.error.bind(console),
  warning: console.warn.bind(console),
  notice: console.log.bind(console),
  debug: console.log.bind(console),
});

export function registerProxy<T>(
  target: T, 
  descriptor: ProxyDescriptor, 
  transport: IpcMain = ipcMain, 
  logger?: typeof exampleLogger,
): VoidFunction {
  const { channel } = descriptor;

  if (registrations[channel] !== null && registrations[channel] !== undefined) {
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
        if (sender !== undefined) {
          sender.send(correlationId, { type: ResponseType.Result, result });
          sender.removeListener('destroyed', nullify);
        }
      })
      .catch((error) => {
        if (sender !== undefined) {
          let stringifiedRequest = '';
          try {
            stringifiedRequest = request === undefined ? '' : JSON.stringify(request);
          } catch {
            stringifiedRequest = request.type;
          }
          logger?.error?.(`E-0 IPC Error on ${channel} ${stringifiedRequest} ${(error as Error).message} ${(error as Error).stack ?? ''}`);
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

  if (server === undefined) {
    throw new IpcProxyError(`No proxy is registered on channel ${channel}`);
  }

  server?.unsubscribeAll?.();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete registrations[channel];

  // Also clean up worker handler
  const workerHandler = workerProxyHandlers.get(channel);
  workerHandler?.unsubscribeAll();
  workerProxyHandlers.delete(channel);
  workerProxyDescriptors.delete(channel);
}

class ProxyServerHandler {
  constructor(private readonly target: any) {}

  private subscriptions: Record<string, Subscription | undefined> = {};

  public async handleRequest(request: Request, sender: WebContents): Promise<any> {
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
    Object.values(this.subscriptions).forEach((subscription) => subscription?.unsubscribe?.());
    this.subscriptions = {};
  }

  private async handleGet(request: GetRequest): Promise<any> {
    return this.target[request.propKey];
  }

  private handleApply(request: ApplyRequest): any {
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

  private doSubscribe(obs: Observable<any>, subscriptionId: string, sender: WebContents): void {
    if (this.subscriptions[subscriptionId] !== undefined) {
      throw new IpcProxyError(`A subscription with Id [${subscriptionId}] already exists`);
    }

    this.subscriptions[subscriptionId] = obs.subscribe({
      next: (value) => {
        sender.send(subscriptionId, { type: ResponseType.Next, value });
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
  send(channel: string, data: any): void {
    if (channel === this.responseId) {
      // Regular response
      const { type, result, error } = data;
      if (type === ResponseType.Result) {
        this.worker.postMessage({
          type: 'service-response',
          id: this.responseId,
          result,
        } satisfies WorkerResponseMessage);
      } else if (type === ResponseType.Error) {
        const errorData = JSON.parse(error);
        this.worker.postMessage({
          type: 'service-response',
          id: this.responseId,
          error: {
            message: errorData.message,
            name: errorData.name,
            stack: errorData.stack,
          },
        } satisfies WorkerResponseMessage);
      }
    } else {
      // Subscription response (channel is subscriptionId)
      const { type, value, error } = data;
      if (type === ResponseType.Next) {
        this.worker.postMessage({
          type: 'service-stream',
          id: this.responseId,
          result: value,
        } satisfies WorkerResponseMessage);
      } else if (type === ResponseType.Error) {
        const errorData = JSON.parse(error);
        this.worker.postMessage({
          type: 'service-stream',
          id: this.responseId,
          error: {
            message: errorData.message,
            name: errorData.name,
            stack: errorData.stack,
          },
        } satisfies WorkerResponseMessage);
      } else if (type === ResponseType.Complete) {
        this.worker.postMessage({
          type: 'service-stream-complete',
          id: this.responseId,
        } satisfies WorkerResponseMessage);
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
      const msg = message as WorkerCallMessage;
      if (msg.type === 'service-call') {
        await handleWorkerServiceCall(worker, msg);
      }
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
  const { id, service: channel, method, args = [] } = message;

  const handler = workerProxyHandlers.get(channel);
  const descriptor = workerProxyDescriptors.get(channel);
  
  if (!handler) {
    worker.postMessage({
      type: 'service-response',
      id,
      error: {
        message: `Service '${channel}' not found`,
        name: 'ServiceNotFoundError',
      },
    } satisfies WorkerResponseMessage);
    return;
  }

  // Create adapter to make Worker compatible with WebContents
  const adapter = new WorkerAdapter(worker, id) as any as WebContents;

  // Determine the correct request type based on descriptor
  const propertyType = descriptor?.properties[method];
  
  let request: Request;
  
  if (propertyType === ProxyPropertyType.Value$) {
    // Observable property - use Subscribe request
    const subscriptionId = `${id}_sub`;
    request = {
      type: RequestType.Subscribe,
      propKey: method,
      subscriptionId,
    } as SubscribeRequest;
  } else if (propertyType === ProxyPropertyType.Function$) {
    // Observable function - use ApplySubscribe request
    const subscriptionId = `${id}_sub`;
    request = {
      type: RequestType.ApplySubscribe,
      propKey: method,
      subscriptionId,
      args,
    } as ApplySubscribeRequest;
  } else if (propertyType === ProxyPropertyType.Value) {
    // Regular property - use Get request
    request = {
      type: RequestType.Get,
      propKey: method,
    } as GetRequest;
  } else {
    // Default to Apply for functions
    request = {
      type: RequestType.Apply,
      propKey: method,
      args,
    } as ApplyRequest;
  }

  try {
    const result = await handler.handleRequest(request, adapter);
    
    // If result is returned (not Observable), send it
    if (result !== undefined) {
      adapter.send(id, { type: ResponseType.Result, result });
    }
  } catch (error) {
    const err = error as Error;
    adapter.send(id, { 
      type: ResponseType.Error, 
      error: JSON.stringify(serializeError(err, { maxDepth: 1 })) 
    });
  }
}

export type { ProxyDescriptor, ProxyPropertyType } from './common';
