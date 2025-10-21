/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * fix https://github.com/electron/electron/issues/28176
 * We cannot pass Observable across contextBridge, so we have to add a hidden patch to the object on preload script, and use that patch to regenerate Observable on renderer side
 * This file is "unsafe" and will full of type warnings, which is necessary
 */
import type { Observer, Subscriber } from 'rxjs';
import { Observable } from 'rxjs/internal/Observable';
import { IServicesWithOnlyObservables, IServicesWithoutObservables, ProxyDescriptor, ProxyPropertyType } from './common.js';
import { getSubscriptionKey } from './utilities.js';

interface IWindow {
  observables: IServicesWithOnlyObservables<any>;
  service: IServicesWithoutObservables<any>;
}

type UnpackObservable<T> = T extends Observable<infer R> ? R : never;

/**
 * Create `(window as IWindow).observables.xxx` from `(window as IWindow).service.xxx`
 * @param name service name
 * @param service service client proxy created in preload script
 * @param descriptor electron ipc proxy descriptor
 */
export function ipcProxyFixContextIsolation<T extends Record<string, any>>(name: keyof IWindow['service'], service: T, descriptor: ProxyDescriptor): void {
  if ((window as unknown as IWindow).observables === undefined) {
    (window as unknown as IWindow).observables = {} as IWindow['observables'];
  }

  for (const key in descriptor.properties) {
    // Process all Observables, we pass a `.next` function from preload script, that we can used to reconstruct Observable
    if (ProxyPropertyType.Value$ === descriptor.properties[key] && !(key in service) && getSubscriptionKey(key) in service) {
      const subscribedObservable = new Observable((subscriber: Subscriber<unknown>) => {
        const serviceMethodReturnedObservable = service[getSubscriptionKey(key)] as T[keyof T];
        // can't use `serviceMethodReturnedObservable(subscriber)` here, because `subscriber` is not serializable during contextBridge
        serviceMethodReturnedObservable({
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
      }) as T[keyof T];
      // store newly created Observable to `(window as IWindow).observables.xxx.yyy`
      if ((window as unknown as IWindow).observables[name as string] === undefined) {
        ((window as unknown as IWindow).observables as any)[name] = {
          [key]: subscribedObservable,
        };
      } else {
        ((window as unknown as IWindow).observables as any)[name][key] = subscribedObservable;
      }
    }
    // create (id: string) => Observable
    if (ProxyPropertyType.Function$ === descriptor.properties[key] && !(key in service) && getSubscriptionKey(key) in service) {
      const subscribingObservable = <K extends Extract<keyof T, string>, InsideObservable extends UnpackObservable<T[K]>>(...arguments_: unknown[]): T[K] =>
        new Observable<InsideObservable>((subscriber: Subscriber<InsideObservable>) => {
          const serviceMethodReturnedObservable = service[getSubscriptionKey(key)](...arguments_) as (observer: Observer<InsideObservable>) => void;
          serviceMethodReturnedObservable({
            next: (value: InsideObservable) => {
              subscriber.next(value);
            },
            complete: () => {
              subscriber.complete();
            },
            error: (error: unknown) => {
              subscriber.error(error);
            },
          });
        }) as T[K];

      // store newly created Observable to `(window as IWindow).observables.xxx.yyy`
      if ((window as unknown as IWindow).observables[name as string] === undefined) {
        ((window as unknown as IWindow).observables as any)[name] = {
          [key]: subscribingObservable,
        };
      } else {
        ((window as unknown as IWindow).observables as any)[name][key] = subscribingObservable;
      }
    }
  }
}

/**
 * Process `(window as IWindow).service`, reconstruct Observables into `(window as IWindow).observables`
 */
export function fixContextIsolation(): void {
  const { descriptors, ...services } = (window as unknown as IWindow).service;

  for (const key in services) {
    const serviceName = key as Exclude<keyof IWindow['service'], 'descriptors'>;
    ipcProxyFixContextIsolation(serviceName, services[serviceName as string], (descriptors as any)[serviceName] as ProxyDescriptor);
  }
}
fixContextIsolation();
