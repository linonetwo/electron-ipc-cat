/**
 * Worker thread client tests
 * Tests createWorkerProxy functionality
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Observable } from 'rxjs';

// Mock ParentPort
class MockParentPort extends EventEmitter {
  public sentMessages: any[] = [];

  postMessage(message: any): void {
    this.sentMessages.push(message);
  }
}

let mockParentPort: MockParentPort;
let createWorkerProxy: typeof import('../dist/worker.js').createWorkerProxy;
let ProxyPropertyType: typeof import('../dist/common.js').ProxyPropertyType;

beforeEach(async () => {
  // Reset modules to clear transport state
  vi.resetModules();
  
  // Create new mock
  mockParentPort = new MockParentPort();
  
  vi.doMock('worker_threads', () => ({
    parentPort: mockParentPort,
  }));

  // Re-import after mocking
  const workerModule = await import('../src/worker.js');
  const commonModule = await import('../src/common.js');
  
  createWorkerProxy = workerModule.createWorkerProxy;
  ProxyPropertyType = commonModule.ProxyPropertyType;
});

describe('Worker Proxy - Function Calls', () => {
  it('should call function without arguments', async () => {
    const descriptor = {
      channel: 'TestChannel',
      properties: {
        getString: ProxyPropertyType.Function,
      },
    };

    const proxy = createWorkerProxy<any>(descriptor, Observable);

    const promise = proxy.getString();
    await new Promise(resolve => setImmediate(resolve));

    expect(mockParentPort.sentMessages.length).toBeGreaterThan(0);
    const sentMessage = mockParentPort.sentMessages[0];
    expect(sentMessage).toMatchObject({
      type: 'service-call',
      service: 'TestChannel',
      method: 'getString',
      args: [],
    });

    mockParentPort.emit('message', {
      type: 'service-response',
      id: sentMessage.id,
      result: 'hello',
    });

    const result = await promise;
    expect(result).toBe('hello');
  });

  it('should call function with arguments', async () => {
    const descriptor = {
      channel: 'MathChannel',
      properties: {
        add: ProxyPropertyType.Function,
      },
    };

    const proxy = createWorkerProxy<any>(descriptor, Observable);

    const promise = proxy.add(10, 20);
    
    // Wait for message to be sent
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockParentPort.sentMessages.length).toBeGreaterThan(0);
    const sentMessage = mockParentPort.sentMessages[0];
    expect(sentMessage.args).toEqual([10, 20]);

    mockParentPort.emit('message', {
      type: 'service-response',
      id: sentMessage.id,
      result: 30,
    });

    const result = await promise;
    expect(result).toBe(30);
  });

  it('should handle errors', async () => {
    const descriptor = {
      channel: 'ErrorChannel',
      properties: {
        fail: ProxyPropertyType.Function,
      },
    };

    const proxy = createWorkerProxy<any>(descriptor, Observable);

    const promise = proxy.fail();
    
    // Wait for message to be sent
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockParentPort.sentMessages.length).toBeGreaterThan(0);
    const sentMessage = mockParentPort.sentMessages[0];
    mockParentPort.emit('message', {
      type: 'service-response',
      id: sentMessage.id,
      error: {
        message: 'Failed',
        name: 'Error',
      },
    });

    await expect(promise).rejects.toThrow('Failed');
  });
});

describe('Worker Proxy - Observable', () => {
  it('should include requestType and subscriptionId when unsubscribing', async () => {
    const descriptor = {
      channel: 'UnsubscribeChannel',
      properties: {
        data$: ProxyPropertyType.Value$,
      },
    };

    const proxy = createWorkerProxy<any>(descriptor, Observable);

    const subscription = proxy.data$.subscribe({
      next: () => {},
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const subscribeMessage = mockParentPort.sentMessages[0];
    expect(subscribeMessage.requestType).toBe('subscribe');
    expect(subscribeMessage.subscriptionId).toBe(subscribeMessage.id);

    subscription.unsubscribe();

    await new Promise(resolve => setTimeout(resolve, 10));

    const unsubscribeMessage = mockParentPort.sentMessages[1];
    expect(unsubscribeMessage.requestType).toBe('unsubscribe');
    expect(unsubscribeMessage.subscriptionId).toBe(subscribeMessage.id);
  });

  it('should subscribe to observable', async () => {
    const descriptor = {
      channel: 'ObsChannel',
      properties: {
        data$: ProxyPropertyType.Value$,
      },
    };

    const proxy = createWorkerProxy<any>(descriptor, Observable);

    const values: any[] = [];
    const completePromise = new Promise<void>((resolve) => {
      const sub = proxy.data$.subscribe({
        next: (v: any) => {
          values.push(v);
          if (values.length === 2) {
            sub.unsubscribe();
            resolve();
          }
        },
      });

      setTimeout(() => {
        const msg = mockParentPort.sentMessages[0];
        mockParentPort.emit('message', {
          type: 'service-stream',
          id: msg.id,
          result: 1,
        });
        mockParentPort.emit('message', {
          type: 'service-stream',
          id: msg.id,
          result: 2,
        });
      }, 10);
    });

    await completePromise;
    expect(values).toEqual([1, 2]);
  });

  it('should handle stream completion', async () => {
    const descriptor = {
      channel: 'StreamChannel',
      properties: {
        numbers$: ProxyPropertyType.Function$,
      },
    };

    const proxy = createWorkerProxy<any>(descriptor, Observable);

    let completed = false;
    const values: number[] = [];

    const completePromise = new Promise<void>((resolve) => {
      proxy.numbers$(10).subscribe({
        next: (v: number) => values.push(v),
        complete: () => {
          completed = true;
          resolve();
        },
      });

      setTimeout(() => {
        const msg = mockParentPort.sentMessages[0];
        expect(msg.args).toEqual([10]);
        
        mockParentPort.emit('message', {
          type: 'service-stream',
          id: msg.id,
          result: 1,
        });
        mockParentPort.emit('message', {
          type: 'service-stream',
          id: msg.id,
          result: 2,
        });
        mockParentPort.emit('message', {
          type: 'service-stream-complete',
          id: msg.id,
        });
      }, 10);
    });

    await completePromise;
    expect(values).toEqual([1, 2]);
    expect(completed).toBe(true);
  });

  it('should handle stream errors', async () => {
    const descriptor = {
      channel: 'ErrorStreamChannel',
      properties: {
        failing$: ProxyPropertyType.Value$,
      },
    };

    const proxy = createWorkerProxy<any>(descriptor, Observable);

    let errorReceived: Error | null = null;

    const errorPromise = new Promise<void>((resolve) => {
      proxy.failing$.subscribe({
        next: () => {},
        error: (err: Error) => {
          errorReceived = err;
          resolve();
        },
      });

      setTimeout(() => {
        const msg = mockParentPort.sentMessages[0];
        
        mockParentPort.emit('message', {
          type: 'service-stream',
          id: msg.id,
          error: {
            message: 'Stream failed',
            name: 'StreamError',
          },
        });
      }, 10);
    });

    await errorPromise;
    expect(errorReceived).toBeDefined();
    expect(errorReceived!.message).toBe('Stream failed');
    expect(errorReceived!.name).toBe('StreamError');
  });

  it('should handle Value property type', async () => {
    const descriptor = {
      channel: 'ValueChannel',
      properties: {
        config: ProxyPropertyType.Value,
      },
    };

    const proxy = createWorkerProxy<any>(descriptor, Observable);

    const promise = proxy.config;
    
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockParentPort.sentMessages.length).toBeGreaterThan(0);
    const sentMessage = mockParentPort.sentMessages[0];
    expect(sentMessage.method).toBe('config');
    expect(sentMessage.args).toEqual([]);

    mockParentPort.emit('message', {
      type: 'service-response',
      id: sentMessage.id,
      result: { setting1: 'value1', setting2: true },
    });

    const result = await promise;
    expect(result).toEqual({ setting1: 'value1', setting2: true });
  });

  it('should handle timeout for function calls', async () => {
    vi.useFakeTimers();

    const descriptor = {
      channel: 'TimeoutChannel',
      properties: {
        slowMethod: ProxyPropertyType.Function,
      },
    };

    const proxy = createWorkerProxy<any>(descriptor, Observable);

    const promise = proxy.slowMethod();
    
    // Fast-forward time beyond 30 seconds timeout
    vi.advanceTimersByTime(31000);

    await expect(promise).rejects.toThrow('Service call timeout');

    vi.useRealTimers();
  });

  it('should handle timeout for observable streams', async () => {
    vi.useFakeTimers();

    const descriptor = {
      channel: 'TimeoutObsChannel',
      properties: {
        slowStream$: ProxyPropertyType.Value$,
      },
    };

    const proxy = createWorkerProxy<any>(descriptor, Observable);

    let errorReceived: Error | null = null;

    const errorPromise = new Promise<void>((resolve) => {
      proxy.slowStream$.subscribe({
        next: () => {},
        error: (err: Error) => {
          errorReceived = err;
          resolve();
        },
      });

      // Fast-forward time beyond 120 seconds initial timeout
      vi.advanceTimersByTime(121_000);
    });

    await errorPromise;
    expect(errorReceived).toBeDefined();
    expect(errorReceived!.message).toContain('timeout');

    vi.useRealTimers();
  });

  it('should throw error when Observable constructor not provided for observable properties', () => {
    const descriptor = {
      channel: 'ObsChannel',
      properties: {
        data$: ProxyPropertyType.Value$,
      },
    };

    expect(() => {
      createWorkerProxy<any>(descriptor, null as any);
    }).toThrow('Observable constructor');
  });

  it('should throw error when Observable constructor not provided for observable functions', () => {
    const descriptor = {
      channel: 'ObsChannel',
      properties: {
        getData$: ProxyPropertyType.Function$,
      },
    };

    expect(() => {
      createWorkerProxy<any>(descriptor, null as any);
    }).toThrow('Observable constructor');
  });

  it('should throw error when parentPort is not available', async () => {
    vi.resetModules();
    
    vi.doMock('worker_threads', () => ({
      parentPort: null,
    }));

    const { createDefaultWorkerTransport } = await import('../src/worker.js');
    
    expect(() => {
      createDefaultWorkerTransport();
    }).toThrow('parentPort is not available');
  });

  it('should handle custom transport', async () => {
    vi.useRealTimers();
    const customMessages: any[] = [];
    const customEmitter = new EventEmitter();

    const customTransport = {
      postMessage: (message: any) => {
        customMessages.push(message);
      },
      on: (event: string, handler: (...args: any[]) => void) => {
        customEmitter.on(event, handler);
      },
    };

    const descriptor = {
      channel: 'CustomChannel',
      properties: {
        test: ProxyPropertyType.Function,
      },
    };

    const proxy = createWorkerProxy<any>(descriptor, Observable, customTransport);

    const promise = proxy.test('arg1');
    
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(customMessages.length).toBeGreaterThan(0);
    expect(customMessages[0]).toMatchObject({
      type: 'service-call',
      service: 'CustomChannel',
      method: 'test',
      args: ['arg1'],
    });

    customEmitter.emit('message', {
      type: 'service-response',
      id: customMessages[0].id,
      result: 'custom-result',
    });

    const result = await promise;
    expect(result).toBe('custom-result');
  });
});

