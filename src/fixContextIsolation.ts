/**
 * fix https://github.com/electron/electron/issues/28176
 * We cannot pass Observable across contextBridge, so we have to add a hidden patch to the object on preload script, and use that patch to regenerate Observable on renderer side
 * This file handles type safety by properly typing all operations
 */
import type { Subscriber } from 'rxjs';
import { Observable } from 'rxjs/internal/Observable';
import type { IServicesWithOnlyObservables, IServicesWithoutObservables } from './common.js';
import { type ProxyDescriptor, ProxyPropertyType } from './common.js';
import { getSubscriptionKey } from './utilities.js';

interface IWindow {
  observables: IServicesWithOnlyObservables<Record<string, unknown>>;
  service: IServicesWithoutObservables<Record<string, unknown>>;
}

interface PartialObserver<T> {
  next?(value: T): void;
  complete?(): void;
  error?(error: unknown): void;
}

/**
 * Create `(window as IWindow).observables.xxx` from `(window as IWindow).service.xxx`
 * @param name service name
 * @param service service client proxy created in preload script
 * @param descriptor electron ipc proxy descriptor
 */
export function ipcProxyFixContextIsolation(name: keyof IWindow['service'], service: Record<string, unknown>, descriptor: ProxyDescriptor): void {
  // Runtime check - window.observables might not exist yet
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if ((window as unknown as IWindow).observables === undefined) {
    (window as unknown as IWindow).observables = {} as IWindow['observables'];
  }

  for (const key in descriptor.properties) {
    // Process all Observables, we pass a `.next` function from preload script, that we can used to reconstruct Observable
    if (ProxyPropertyType.Value$ === descriptor.properties[key] && getSubscriptionKey(key) in service) {
      const subscribedObservable = new Observable((subscriber: Subscriber<unknown>) => {
        const subscribeFunction = service[getSubscriptionKey(key)] as (observer: PartialObserver<unknown>) => void;
        // can't use `subscribeFunction(subscriber)` here, because `subscriber` is not serializable during contextBridge
        subscribeFunction({
          next: (value: unknown) => {
            subscriber.next(value);
          },
          complete: () => {
            subscriber.complete();
          },
          error: (error: unknown) => {
            subscriber.error(error);
          },
        });
      });
      // store newly created Observable to `(window as IWindow).observables.xxx.yyy`
      const windowObservables = (window as unknown as IWindow).observables as Record<string, Record<string, unknown>>;
      const serviceName = name;
      // Runtime check - this specific service namespace might not be initialized yet
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!windowObservables[serviceName]) {
        windowObservables[serviceName] = {
          [key]: subscribedObservable,
        };
      } else {
        windowObservables[serviceName][key] = subscribedObservable;
      }
    }
    // create (id: string) => Observable
    if (ProxyPropertyType.Function$ === descriptor.properties[key] && getSubscriptionKey(key) in service) {
      const subscribingObservable = (...arguments_: unknown[]) =>
        new Observable<unknown>((subscriber: Subscriber<unknown>) => {
          const subscribeFunction = (service[getSubscriptionKey(key)] as (...arguments__: unknown[]) => (observer: PartialObserver<unknown>) => void)(...arguments_);
          subscribeFunction({
            next: (value: unknown) => {
              subscriber.next(value);
            },
            complete: () => {
              subscriber.complete();
            },
            error: (error: unknown) => {
              subscriber.error(error);
            },
          });
        });

      // store newly created Observable to `(window as IWindow).observables.xxx.yyy`
      const windowObservables = (window as unknown as IWindow).observables as Record<string, Record<string, unknown>>;
      const serviceName = name;
      // Runtime check - this specific service namespace might not be initialized yet
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!windowObservables[serviceName]) {
        windowObservables[serviceName] = {
          [key]: subscribingObservable,
        };
      } else {
        windowObservables[serviceName][key] = subscribingObservable;
      }
    }
  }
}

/**
 * Process `(window as IWindow).service`, reconstruct Observables into `(window as IWindow).observables`
 */
export function fixContextIsolation(): void {
  // Only run in browser environment with window.service defined
  if (typeof window === 'undefined') {
    return;
  }

  const windowObject = window as unknown as IWindow;
  // Runtime check - service might not exist
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!windowObject.service) {
    return;
  }

  const windowService = windowObject.service;
  const { descriptors, ...services } = windowService;

  // Iterate through all services except 'descriptors'
  Object.keys(services).forEach((key) => {
    const serviceName = key;
    const serviceValue = services[key];
    // Safely access descriptor - narrowing type via checked property access
    if (!(key in descriptors)) {
      return;
    }
    const serviceDescriptor = (descriptors[key as keyof typeof descriptors]) as ProxyDescriptor;
    ipcProxyFixContextIsolation(serviceName, serviceValue, serviceDescriptor);
  });
}

// Auto-execute in browser environment
if (typeof window !== 'undefined') {
  fixContextIsolation();
}
