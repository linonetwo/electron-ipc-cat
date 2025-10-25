/**
 * Tests for void/undefined return values
 * Bug: Methods that return void or undefined don't send responses,
 * causing timeouts and memory leaks
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mock IpcMain and WebContents
class MockIpcMain extends EventEmitter {
  public handlers = new Map<string, any>();

  on(channel: string, listener: any): this {
    this.handlers.set(channel, listener);
    return super.on(channel, listener);
  }

  removeAllListeners(channel?: string): this {
    if (channel) {
      this.handlers.delete(channel);
    } else {
      this.handlers.clear();
    }
    return super.removeAllListeners(channel);
  }
}

class MockWebContents extends EventEmitter {
  public messages: Array<{ channel: string; data: any }> = [];
  public isDestroyed = false;

  send(channel: string, data: any): void {
    if (!this.isDestroyed) {
      this.messages.push({ channel, data });
    }
  }

  destroy(): void {
    this.isDestroyed = true;
    this.emit('destroyed');
  }
}

class MockIpcMainEvent {
  constructor(public sender: MockWebContents) {}
}

const mockIpcMain = new MockIpcMain();

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
}));

const { registerProxy } = await import('../src/server.js');
const { ProxyPropertyType, RequestType, ResponseType } = await import('../src/common.js');

describe('Void Return Value Handling', () => {
  beforeEach(() => {
    mockIpcMain.handlers.clear();
  });

  it('should send response for void methods', async () => {
    let sideEffectValue = 0;
    
    const service = {
      doSomething: () => {
        sideEffectValue = 42;
        // Explicitly returns void
      },
    };

    const descriptor = {
      channel: 'VoidChannel',
      properties: {
        doSomething: ProxyPropertyType.Function,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);
    const handler = mockIpcMain.handlers.get('VoidChannel')!;
    const sender = new MockWebContents();
    const event = new MockIpcMainEvent(sender);

    await handler(event, {
      type: RequestType.Apply,
      propKey: 'doSomething',
      args: [],
    }, 'correlation-void');

    await new Promise(resolve => setImmediate(resolve));

    // Side effect should have executed
    expect(sideEffectValue).toBe(42);

    // Should still send a response (even for void)
    expect(sender.messages.length).toBeGreaterThan(0);
    expect(sender.messages[0].data.type).toBe(ResponseType.Result);
    
    cleanup();
  });

  it('should send response for methods that return undefined', async () => {
    const service = {
      returnUndefined: () => undefined,
    };

    const descriptor = {
      channel: 'UndefinedChannel',
      properties: {
        returnUndefined: ProxyPropertyType.Function,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);
    const handler = mockIpcMain.handlers.get('UndefinedChannel')!;
    const sender = new MockWebContents();
    const event = new MockIpcMainEvent(sender);

    await handler(event, {
      type: RequestType.Apply,
      propKey: 'returnUndefined',
      args: [],
    }, 'correlation-undefined');

    await new Promise(resolve => setImmediate(resolve));

    // Should send a response
    expect(sender.messages.length).toBeGreaterThan(0);
    expect(sender.messages[0].data.type).toBe(ResponseType.Result);
    expect(sender.messages[0].data.result).toBeUndefined();

    cleanup();
  });

  it('should send response for async void methods', async () => {
    let asyncEffectValue = 0;

    const service = {
      doSomethingAsync: async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        asyncEffectValue = 99;
      },
    };

    const descriptor = {
      channel: 'AsyncVoidChannel',
      properties: {
        doSomethingAsync: ProxyPropertyType.Function,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);
    const handler = mockIpcMain.handlers.get('AsyncVoidChannel')!;
    const sender = new MockWebContents();
    const event = new MockIpcMainEvent(sender);

    await handler(event, {
      type: RequestType.Apply,
      propKey: 'doSomethingAsync',
      args: [],
    }, 'correlation-async-void');

    await new Promise(resolve => setTimeout(resolve, 20));

    // Side effect should have executed
    expect(asyncEffectValue).toBe(99);

    // Should send a response
    expect(sender.messages.length).toBeGreaterThan(0);
    expect(sender.messages[0].data.type).toBe(ResponseType.Result);

    cleanup();
  });

  it('should distinguish between undefined and no return', async () => {
    const service = {
      explicitUndefined: () => undefined,
      implicitVoid: () => {
        // No return statement
      },
    };

    const descriptor = {
      channel: 'ReturnTypeChannel',
      properties: {
        explicitUndefined: ProxyPropertyType.Function,
        implicitVoid: ProxyPropertyType.Function,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);
    const handler = mockIpcMain.handlers.get('ReturnTypeChannel')!;
    
    // Test explicit undefined
    const sender1 = new MockWebContents();
    const event1 = new MockIpcMainEvent(sender1);
    await handler(event1, {
      type: RequestType.Apply,
      propKey: 'explicitUndefined',
      args: [],
    }, 'correlation-explicit');
    await new Promise(resolve => setImmediate(resolve));
    expect(sender1.messages.length).toBeGreaterThan(0);

    // Test implicit void
    const sender2 = new MockWebContents();
    const event2 = new MockIpcMainEvent(sender2);
    await handler(event2, {
      type: RequestType.Apply,
      propKey: 'implicitVoid',
      args: [],
    }, 'correlation-implicit');
    await new Promise(resolve => setImmediate(resolve));
    expect(sender2.messages.length).toBeGreaterThan(0);

    cleanup();
  });
});

describe('Worker Void Return Value Handling', () => {
  beforeEach(() => {
    mockIpcMain.handlers.clear();
  });

  it('should handle void methods for worker calls', async () => {
    let workerEffectValue = 0;

    const service = {
      workerVoidMethod: () => {
        workerEffectValue = 123;
      },
    };

    const descriptor = {
      channel: 'WorkerVoidChannel',
      properties: {
        workerVoidMethod: ProxyPropertyType.Function,
      },
    };

    const { attachWorker } = await import('../src/server.js');
    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);

    const EventEmitter = (await import('events')).EventEmitter;
    const workerEmitter = new EventEmitter();
    const messages: any[] = [];

    const mockWorker = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.on(event, handler);
      }),
      once: vi.fn(),
      removeListener: vi.fn(),
      postMessage: vi.fn((msg: any) => {
        messages.push(msg);
      }),
    } as any;

    const workerCleanup = attachWorker(mockWorker);

    // Simulate worker calling void method
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-void-1',
      service: 'WorkerVoidChannel',
      method: 'workerVoidMethod',
      args: [],
    });

    await new Promise(resolve => setTimeout(resolve, 20));

    // Side effect should execute
    expect(workerEffectValue).toBe(123);

    // Should send response to worker
    expect(messages.length).toBeGreaterThan(0);
    const response = messages.find(m => m.type === 'service-response');
    expect(response).toBeDefined();
    expect(response.id).toBe('worker-void-1');

    workerCleanup();
    cleanup();
  });
});
