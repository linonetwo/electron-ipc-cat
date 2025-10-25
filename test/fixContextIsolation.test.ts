/**
 * Tests for fixContextIsolation
 * This module fixes Observable passing across Electron's contextBridge
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { Observable } from 'rxjs';

const { ProxyPropertyType } = await import('../src/common.js');
const { getSubscriptionKey } = await import('../src/utilities.js');

describe('fixContextIsolation', () => {
  let dom: JSDOM;
  let window: any;
  let ipcProxyFixContextIsolation: any;

  beforeEach(async () => {
    // Create a fresh DOM environment for each test
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost',
      runScripts: 'dangerously',
    });
    window = dom.window;
    (global as any).window = window;

    // Dynamically import to avoid auto-execution
    const module = await import('../src/fixContextIsolation.js?t=' + Date.now());
    ipcProxyFixContextIsolation = module.ipcProxyFixContextIsolation;
  });

  it('should reconstruct Observable from Value$ property', () => {
    const descriptor = {
      channel: 'ThemeChannel',
      properties: {
        theme$: ProxyPropertyType.Value$,
      },
    };

    // Simulate what createProxy creates - it has a theme$ getter property
    const mockService = {
      [getSubscriptionKey('theme$')]: (observer: any) => {
        // Simulate subscription
        observer.next({ color: 'dark' });
        observer.complete();
      },
    };

    // Add theme$ as a getter (like createProxy does)
    Object.defineProperty(mockService, 'theme$', {
      get() {
        return new Observable((subscriber) => {
          this[getSubscriptionKey('theme$')](subscriber);
        });
      },
      enumerable: true,
      configurable: true,
    });

    // Set up window.service like preload script does
    window.service = {
      theme: mockService,
      descriptors: {
        theme: descriptor,
      },
    };

    // Run fixContextIsolation
    ipcProxyFixContextIsolation('theme', mockService, descriptor);

    // Check if Observable was reconstructed
    expect(window.observables).toBeDefined();
    expect(window.observables.theme).toBeDefined();
    expect(window.observables.theme.theme$).toBeDefined();

    // Test that the reconstructed Observable works
    let receivedValue: any = null;
    let completed = false;

    window.observables.theme.theme$.subscribe({
      next: (value: any) => {
        receivedValue = value;
      },
      complete: () => {
        completed = true;
      },
    });

    expect(receivedValue).toEqual({ color: 'dark' });
    expect(completed).toBe(true);
  });

  it('should reconstruct Observable from Function$ property', () => {
    const descriptor = {
      channel: 'DataChannel',
      properties: {
        getData$: ProxyPropertyType.Function$,
      },
    };

    // Simulate what createProxy creates
    const mockService = {
      [getSubscriptionKey('getData$')]: (id: number) => (observer: any) => {
        observer.next({ id, value: `data-${id}` });
        observer.complete();
      },
    };

    // Add getData$ as a getter
    Object.defineProperty(mockService, 'getData$', {
      get() {
        return (id: number) => new Observable((subscriber) => {
          this[getSubscriptionKey('getData$')](id)(subscriber);
        });
      },
      enumerable: true,
      configurable: true,
    });

    window.service = {
      data: mockService,
      descriptors: {
        data: descriptor,
      },
    };

    ipcProxyFixContextIsolation('data', mockService, descriptor);

    expect(window.observables).toBeDefined();
    expect(window.observables.data).toBeDefined();
    expect(window.observables.data.getData$).toBeDefined();
    expect(typeof window.observables.data.getData$).toBe('function');

    // Test the reconstructed Observable function
    let receivedValue: any = null;
    let completed = false;

    window.observables.data.getData$(42).subscribe({
      next: (value: any) => {
        receivedValue = value;
      },
      complete: () => {
        completed = true;
      },
    });

    expect(receivedValue).toEqual({ id: 42, value: 'data-42' });
    expect(completed).toBe(true);
  });

  it('should handle the real-world case from TidGi', () => {
    const descriptor = {
      channel: 'ThemeChannel',
      properties: {
        theme$: ProxyPropertyType.Value$,
      },
    };

    // Simulate the actual structure from TidGi's bug report
    const mockService: any = {
      // The Subscribe method (with capital S)
      theme$Subscribe: (observer: any) => {
        observer.next({ mode: 'dark' });
        observer.complete();
      },
    };

    // The theme$ property exists as an object with _subscribe
    mockService['theme$'] = {
      _subscribe: mockService.theme$Subscribe,
    };

    window.service = {
      theme: mockService,
      descriptors: {
        theme: descriptor,
      },
    };

    ipcProxyFixContextIsolation('theme', mockService, descriptor);

    // This should work but currently fails due to the bug
    expect(window.observables).toBeDefined();
    expect(window.observables.theme).toBeDefined();
    expect(window.observables.theme.theme$).toBeDefined();
  });

  it('should handle multiple Observable properties', () => {
    const descriptor = {
      channel: 'MultiChannel',
      properties: {
        stream1$: ProxyPropertyType.Value$,
        stream2$: ProxyPropertyType.Value$,
        getStream$: ProxyPropertyType.Function$,
      },
    };

    const mockService: any = {};

    // Set up stream1$
    mockService[getSubscriptionKey('stream1$')] = (observer: any) => {
      observer.next(1);
      observer.complete();
    };
    Object.defineProperty(mockService, 'stream1$', {
      get() {
        return new Observable((subscriber) => {
          this[getSubscriptionKey('stream1$')](subscriber);
        });
      },
      enumerable: true,
      configurable: true,
    });

    // Set up stream2$
    mockService[getSubscriptionKey('stream2$')] = (observer: any) => {
      observer.next(2);
      observer.complete();
    };
    Object.defineProperty(mockService, 'stream2$', {
      get() {
        return new Observable((subscriber) => {
          this[getSubscriptionKey('stream2$')](subscriber);
        });
      },
      enumerable: true,
      configurable: true,
    });

    // Set up getStream$
    mockService[getSubscriptionKey('getStream$')] = (n: number) => (observer: any) => {
      observer.next(n * 10);
      observer.complete();
    };
    Object.defineProperty(mockService, 'getStream$', {
      get() {
        return (n: number) => new Observable((subscriber) => {
          this[getSubscriptionKey('getStream$')](n)(subscriber);
        });
      },
      enumerable: true,
      configurable: true,
    });

    window.service = {
      multi: mockService,
      descriptors: {
        multi: descriptor,
      },
    };

    ipcProxyFixContextIsolation('multi', mockService, descriptor);

    expect(window.observables.multi.stream1$).toBeDefined();
    expect(window.observables.multi.stream2$).toBeDefined();
    expect(window.observables.multi.getStream$).toBeDefined();
  });

  it('should not process non-Observable properties', () => {
    const descriptor = {
      channel: 'MixedChannel',
      properties: {
        normalValue: ProxyPropertyType.Value,
        normalFunction: ProxyPropertyType.Function,
        observable$: ProxyPropertyType.Value$,
      },
    };

    const mockService: any = {
      normalValue: 'test',
      normalFunction: () => 'result',
    };

    mockService[getSubscriptionKey('observable$')] = (observer: any) => {
      observer.next('obs-value');
      observer.complete();
    };
    Object.defineProperty(mockService, 'observable$', {
      get() {
        return new Observable((subscriber) => {
          this[getSubscriptionKey('observable$')](subscriber);
        });
      },
      enumerable: true,
      configurable: true,
    });

    window.service = {
      mixed: mockService,
      descriptors: {
        mixed: descriptor,
      },
    };

    ipcProxyFixContextIsolation('mixed', mockService, descriptor);

    // Only Observable properties should be in window.observables
    expect(window.observables.mixed.observable$).toBeDefined();
    expect(window.observables.mixed.normalValue).toBeUndefined();
    expect(window.observables.mixed.normalFunction).toBeUndefined();
  });
});
