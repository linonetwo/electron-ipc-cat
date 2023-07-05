/**
 * This file runs in electron preload script
 */
import { Event, IpcRenderer, ipcRenderer } from 'electron';
import memoize from 'memize';
import { isObservable, Observable, Observer, Subscribable, TeardownLogic } from 'rxjs';
import { deserializeError } from 'serialize-error';
import { ProxyDescriptor, ProxyPropertyType, Request, RequestType, Response, ResponseType } from './common.js';
import { getSubscriptionKey, IpcProxyError } from './utils.js';

export type ObservableConstructor = new(subscribe: (obs: Observer<any>) => TeardownLogic) => Subscribable<any>;

export function createProxy<T>(descriptor: ProxyDescriptor, ObservableCtor: ObservableConstructor = Observable, transport: IpcRenderer = ipcRenderer): T {
  const result = {};

  Object.keys(descriptor.properties).forEach((propertyKey) => {
    const propertyType = descriptor.properties[propertyKey];

    // Provide feedback if the Observable constructor has not been passed in
    if ((propertyType === ProxyPropertyType.Value$ || propertyType === ProxyPropertyType.Function$) && typeof ObservableCtor !== 'function') {
      throw new Error(
        'You must provide an implementation of the Observable constructor if you want to proxy Observables. Please see the docs at https://github.com/frankwallis/electron-ipc-proxy.',
      );
    }

    // fix https://github.com/electron/electron/issues/28176
    if (propertyType === ProxyPropertyType.Value$) {
      Object.defineProperty(result, getSubscriptionKey(propertyKey), {
        enumerable: true,
        get: memoize(() => (observerOrNext?: Partial<Observer<unknown>> | ((value: unknown) => void) | undefined) => {
          const ipcProxyObservable = getProperty(propertyType, propertyKey, descriptor.channel, ObservableCtor, transport);
          if (isObservable(ipcProxyObservable)) {
            ipcProxyObservable.subscribe(observerOrNext);
          }
        }),
      });
    } else if (propertyType === ProxyPropertyType.Function$) {
      Object.defineProperty(result, getSubscriptionKey(propertyKey), {
        enumerable: true,
        get: memoize(() => (...arguments_: unknown[]) => (observerOrNext?: Partial<Observer<unknown>> | ((value: unknown) => void) | undefined) => {
          const ipcProxyObservableFunction = getProperty(propertyType, propertyKey, descriptor.channel, ObservableCtor, transport);
          if (typeof ipcProxyObservableFunction === 'function') {
            const ipcProxyObservable = ipcProxyObservableFunction(...arguments_);
            if (isObservable(ipcProxyObservable)) {
              ipcProxyObservable.subscribe(observerOrNext);
            }
          }
        }),
      });
    } else {
      Object.defineProperty(result, propertyKey, {
        enumerable: true,
        get: memoize(() => getProperty(propertyType, propertyKey, descriptor.channel, ObservableCtor, transport) as unknown),
      });
    }
  });

  return result as T;
}

function getProperty(
  propertyType: ProxyPropertyType,
  propertyKey: string,
  channel: string,
  ObservableCtor: ObservableConstructor,
  transport: IpcRenderer,
): Promise<any> | Subscribable<any> | ((...arguments_: any[]) => Promise<any>) | ((...arguments_: any[]) => Subscribable<any>) {
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
      return (...arguments_: any[]) => makeObservable({ type: RequestType.ApplySubscribe, propKey: propertyKey, args: arguments_ }, channel, ObservableCtor, transport);
    }
    default: {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new IpcProxyError(`Unrecognised ProxyPropertyType [${propertyType}]`);
    }
  }
}

async function makeRequest(request: Request, channel: string, transport: IpcRenderer): Promise<unknown> {
  const correlationId = String(Math.random());
  transport.send(channel, request, correlationId);

  return await new Promise((resolve, reject) => {
    transport.once(correlationId, (event: Event, response: Response) => {
      switch (response.type) {
        case ResponseType.Result: {
          resolve(response.result);
          return;
        }
        case ResponseType.Error: {
          reject(deserializeError(JSON.parse(response.error)));
          return;
        }
        default: {
          reject(new IpcProxyError(`Unhandled response type [${response.type}]`));
        }
      }
    });
  });
}

function makeObservable(request: Request, channel: string, ObservableCtor: ObservableConstructor, transport: IpcRenderer): Subscribable<any> {
  return new ObservableCtor((observer) => {
    const subscriptionId = String(Math.random());
    const subscriptionRequest = { ...request, subscriptionId };

    const onComplete = () => {
      makeRequest({ type: RequestType.Unsubscribe, subscriptionId }, channel, transport).catch((error) => {
        console.log('Error unsubscribing from remote observale', error);
        observer.error(error);
      });
      transport.removeAllListeners(subscriptionId);
    };

    transport.on(subscriptionId, (event: Event, response: Response) => {
      switch (response.type) {
        case ResponseType.Next: {
          observer.next(response.value);
          return;
        }
        case ResponseType.Error: {
          observer.error(deserializeError(JSON.parse(response.error)));
          return;
        }
        case ResponseType.Complete: {
          observer.complete();
          return;
        }
        default: {
          observer.error(new IpcProxyError(`Unhandled response type [${response.type}]`));
        }
      }
    });

    makeRequest(subscriptionRequest, channel, transport).catch((error: Error) => {
      console.log('Error subscribing to remote observable', error);
      observer.error(error);
    });

    return onComplete;
  });
}

export type { ProxyDescriptor, ProxyPropertyType } from './common';
