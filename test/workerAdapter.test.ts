/**
 * WorkerAdapter tests
 * Comprehensive tests for WorkerAdapter that makes Worker compatible with WebContents interface
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { BehaviorSubject, Subject, Observable } from 'rxjs';
import { Worker } from 'worker_threads';

// Import test utilities from registration test
class MockIpcMain extends EventEmitter {
  public handlers = new Map<string, any>();

  handle(channel: string, listener: any): void {
    this.handlers.set(channel, listener);
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

// Mock electron before importing server
vi.mock('electron', () => ({
  ipcMain: new MockIpcMain(),
}));

const { registerProxy, attachWorker } = await import('../src/server.js');
const { ProxyPropertyType, RequestType, ResponseType } = await import('../src/common.js');

const mockIpcMain = new MockIpcMain();

describe('WorkerAdapter - Result Response', () => {
  beforeEach(() => {
    mockIpcMain.handlers.clear();
  });

  it('should send Result response to worker', async () => {
    const service = {
      getData: async () => ({ id: 1, name: 'Test' }),
    };

    const descriptor = {
      channel: 'ResultChannel',
      properties: {
        getData: ProxyPropertyType.Function,
      },
    };

    const cleanup = registerProxy(service, descriptor);

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
    } as any as Worker;

    const workerCleanup = attachWorker(mockWorker);

    // Simulate worker calling getData
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-result-1',
      service: 'ResultChannel',
      method: 'getData',
      args: [],
    });

    await new Promise(resolve => setTimeout(resolve, 20));

    // Should send service-response with result
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'service-response',
      id: 'worker-result-1',
      result: { id: 1, name: 'Test' },
    });

    workerCleanup();
    cleanup();
  });

  it('should send Error response to worker', async () => {
    const service = {
      failMethod: async () => {
        throw new Error('Method failed');
      },
    };

    const descriptor = {
      channel: 'ErrorResultChannel',
      properties: {
        failMethod: ProxyPropertyType.Function,
      },
    };

    const cleanup = registerProxy(service, descriptor);

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
    } as any as Worker;

    const workerCleanup = attachWorker(mockWorker);

    // Simulate worker calling failMethod
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-error-1',
      service: 'ErrorResultChannel',
      method: 'failMethod',
      args: [],
    });

    await new Promise(resolve => setTimeout(resolve, 20));

    // Should send service-response with error
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('service-response');
    expect(messages[0].id).toBe('worker-error-1');
    expect(messages[0].error).toBeDefined();
    expect(messages[0].error.message).toContain('Method failed');

    workerCleanup();
    cleanup();
  });
});

describe('WorkerAdapter - Observable Stream Responses', () => {
  beforeEach(() => {
    mockIpcMain.handlers.clear();
  });

  it('should send Next stream response to worker', async () => {
    const subject = new Subject<number>();
    const service = {
      numbers$: subject,
    };

    const descriptor = {
      channel: 'StreamNextChannel',
      properties: {
        numbers$: ProxyPropertyType.Value$,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);

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
    } as any as Worker;

    const workerCleanup = attachWorker(mockWorker);

    // Simulate worker subscribing
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-next-1',
      service: 'StreamNextChannel',
      method: 'numbers$',
      args: [],
    });

    await new Promise(resolve => setTimeout(resolve, 30));

    // Emit values through the subject
    subject.next(100);
    await new Promise(resolve => setTimeout(resolve, 20));

    subject.next(200);
    await new Promise(resolve => setTimeout(resolve, 20));

    // Check messages sent to worker
    const nextMessages = messages.filter((m: any) => m.type === 'service-stream' && !m.error);
    expect(nextMessages.length).toBeGreaterThanOrEqual(2);
    expect(nextMessages[0].result).toBe(100);
    expect(nextMessages[1].result).toBe(200);

    workerCleanup();
    cleanup();
  });

  it('should send Error stream response to worker via WorkerAdapter', async () => {
    const errorSubject = new Subject<number>();
    const service = {
      errorStream$: errorSubject,
    };

    const descriptor = {
      channel: 'StreamErrorChannel',
      properties: {
        errorStream$: ProxyPropertyType.Value$,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);

    const workerEmitter = new EventEmitter();
    const messages: any[] = [];
    const mockWorker = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.on(event, handler);
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.once(event, handler);
      }),
      removeListener: vi.fn(),
      postMessage: vi.fn((msg: any) => {
        messages.push(msg);
      }),
    } as any as Worker;

    const workerCleanup = attachWorker(mockWorker);

    // Simulate worker subscribing
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-stream-err-1',
      service: 'StreamErrorChannel',
      method: 'errorStream$',
      args: [],
    });

    await new Promise(resolve => setTimeout(resolve, 30));

    // Emit an error through the subject
    const testError = new Error('Stream error');
    errorSubject.error(testError);

    await new Promise(resolve => setTimeout(resolve, 30));

    // Should have sent error message
    const errorMessages = messages.filter((m: any) => m.type === 'service-stream' && m.error);
    expect(errorMessages.length).toBeGreaterThan(0);
    expect(errorMessages[0].error.message).toContain('Stream error');

    workerCleanup();
    cleanup();
  });

  it('should send Complete stream response to worker via WorkerAdapter', async () => {
    const completeSubject = new Subject<number>();
    const service = {
      completeStream$: completeSubject,
    };

    const descriptor = {
      channel: 'StreamCompleteChannel',
      properties: {
        completeStream$: ProxyPropertyType.Value$,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);

    const workerEmitter = new EventEmitter();
    const messages: any[] = [];
    const mockWorker = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.on(event, handler);
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.once(event, handler);
      }),
      removeListener: vi.fn(),
      postMessage: vi.fn((msg: any) => {
        messages.push(msg);
      }),
    } as any as Worker;

    const workerCleanup = attachWorker(mockWorker);

    // Simulate worker subscribing
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-complete-1',
      service: 'StreamCompleteChannel',
      method: 'completeStream$',
      args: [],
    });

    await new Promise(resolve => setTimeout(resolve, 30));

    // Emit values and complete
    completeSubject.next(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    completeSubject.next(2);
    await new Promise(resolve => setTimeout(resolve, 20));
    completeSubject.complete();

    await new Promise(resolve => setTimeout(resolve, 30));

    // Should have sent complete message
    const completeMessages = messages.filter((m: any) => m.type === 'service-stream-complete');
    expect(completeMessages.length).toBeGreaterThan(0);
    expect(completeMessages[0].id).toBe('worker-complete-1');

    workerCleanup();
    cleanup();
  });

  it('should handle Observable function that returns stream', async () => {
    const service = {
      getNumbers$: (count: number) => new Observable<number>((observer) => {
        for (let i = 1; i <= count; i++) {
          observer.next(i);
        }
        observer.complete();
      }),
    };

    const descriptor = {
      channel: 'ObservableFunctionChannel',
      properties: {
        getNumbers$: ProxyPropertyType.Function$,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);

    const workerEmitter = new EventEmitter();
    const messages: any[] = [];
    const mockWorker = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.on(event, handler);
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.once(event, handler);
      }),
      removeListener: vi.fn(),
      postMessage: vi.fn((msg: any) => {
        messages.push(msg);
      }),
    } as any as Worker;

    const workerCleanup = attachWorker(mockWorker);

    // Simulate worker calling observable function
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-obs-func-1',
      service: 'ObservableFunctionChannel',
      method: 'getNumbers$',
      args: [3],
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Should have stream messages and complete
    const streamMessages = messages.filter((m: any) => m.type === 'service-stream');
    const completeMessages = messages.filter((m: any) => m.type === 'service-stream-complete');

    expect(streamMessages.length).toBeGreaterThanOrEqual(3);
    expect(completeMessages.length).toBeGreaterThan(0);

    workerCleanup();
    cleanup();
  });
});

describe('WorkerAdapter - Lifecycle Events', () => {
  beforeEach(() => {
    mockIpcMain.handlers.clear();
  });

  it('should handle worker exit event (once)', async () => {
    const subject = new Subject<number>();
    const service = {
      data$: subject,
    };

    const descriptor = {
      channel: 'ExitOnceChannel',
      properties: {
        data$: ProxyPropertyType.Value$,
      },
    };

    const cleanup = registerProxy(service, descriptor);

    const workerEmitter = new EventEmitter();
    const exitListeners: any[] = [];
    const mockWorker = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.on(event, handler);
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') {
          exitListeners.push(handler);
        }
        workerEmitter.once(event, handler);
      }),
      removeListener: vi.fn(),
      postMessage: vi.fn(),
    } as any as Worker;

    const workerCleanup = attachWorker(mockWorker);

    // Simulate worker subscribing (this triggers WorkerAdapter.once('destroyed'))
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-exit-1',
      service: 'ExitOnceChannel',
      method: 'data$',
      args: [],
    });

    await new Promise(resolve => setTimeout(resolve, 20));

    // Verify that once('exit') was called
    expect(mockWorker.once).toHaveBeenCalledWith('exit', expect.any(Function));

    workerCleanup();
    cleanup();
  });

  it('should handle removeListener for destroyed event', async () => {
    const service = {
      test: async () => 'result',
    };

    const descriptor = {
      channel: 'RemoveListenerChannel',
      properties: {
        test: ProxyPropertyType.Function,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);

    const workerEmitter = new EventEmitter();
    const mockWorker = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.on(event, handler);
      }),
      once: vi.fn(),
      removeListener: vi.fn(),
      postMessage: vi.fn(),
    } as any as Worker;

    const workerCleanup = attachWorker(mockWorker);

    // Simulate worker call
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-remove-1',
      service: 'RemoveListenerChannel',
      method: 'test',
      args: [],
    });

    await new Promise(resolve => setTimeout(resolve, 30));

    // WorkerAdapter creates a listener for 'destroyed' -> 'exit'
    // When the request completes, it should call removeListener
    // The removeListener should have been called when the handler completes
    expect(mockWorker.once).toHaveBeenCalled();

    workerCleanup();
    cleanup();
  });

  it('should handle devtools-reload-page event (no-op for workers)', async () => {
    const subject = new Subject<string>();
    const service = {
      stream$: subject,
    };

    const descriptor = {
      channel: 'DevToolsNoOpChannel',
      properties: {
        stream$: ProxyPropertyType.Value$,
      },
    };

    const cleanup = registerProxy(service, descriptor);

    const workerEmitter = new EventEmitter();
    const onceCallsWith: string[] = [];
    const mockWorker = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.on(event, handler);
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        onceCallsWith.push(event);
        workerEmitter.once(event, handler);
      }),
      removeListener: vi.fn(),
      postMessage: vi.fn(),
    } as any as Worker;

    const workerCleanup = attachWorker(mockWorker);

    // Simulate worker subscribing
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-devtools-1',
      service: 'DevToolsNoOpChannel',
      method: 'stream$',
      args: [],
    });

    await new Promise(resolve => setTimeout(resolve, 20));

    // WorkerAdapter.once should only be called with 'exit' (destroyed)
    // devtools-reload-page is not applicable to workers
    expect(onceCallsWith.filter(e => e === 'exit').length).toBeGreaterThan(0);
    expect(onceCallsWith.filter(e => e === 'devtools-reload-page').length).toBe(0);

    workerCleanup();
    cleanup();
  });
});

describe('WorkerAdapter - Complex Scenarios', () => {
  beforeEach(() => {
    mockIpcMain.handlers.clear();
  });

  it('should handle multiple concurrent worker requests', async () => {
    const service = {
      add: async (a: number, b: number) => a + b,
      multiply: async (a: number, b: number) => a * b,
    };

    const descriptor = {
      channel: 'MathChannel',
      properties: {
        add: ProxyPropertyType.Function,
        multiply: ProxyPropertyType.Function,
      },
    };

    const cleanup = registerProxy(service, descriptor);

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
    } as any as Worker;

    const workerCleanup = attachWorker(mockWorker);

    // Send multiple requests
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-math-1',
      service: 'MathChannel',
      method: 'add',
      args: [10, 20],
    });

    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-math-2',
      service: 'MathChannel',
      method: 'multiply',
      args: [5, 6],
    });

    await new Promise(resolve => setTimeout(resolve, 30));

    // Should receive both responses
    expect(messages.length).toBeGreaterThanOrEqual(2);
    
    const addResponse = messages.find(m => m.id === 'worker-math-1');
    const multiplyResponse = messages.find(m => m.id === 'worker-math-2');

    expect(addResponse?.result).toBe(30);
    expect(multiplyResponse?.result).toBe(30);

    workerCleanup();
    cleanup();
  });

  it('should handle mixed function calls and observables from worker', async () => {
    const subject = new BehaviorSubject<number>(0);
    const service = {
      counter$: subject,
      increment: async () => {
        subject.next(subject.value + 1);
        return subject.value;
      },
    };

    const descriptor = {
      channel: 'CounterChannel',
      properties: {
        counter$: ProxyPropertyType.Value$,
        increment: ProxyPropertyType.Function,
      },
    };

    const cleanup = registerProxy(service, descriptor);

    const workerEmitter = new EventEmitter();
    const messages: any[] = [];
    const mockWorker = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.on(event, handler);
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        workerEmitter.once(event, handler);
      }),
      removeListener: vi.fn(),
      postMessage: vi.fn((msg: any) => {
        messages.push(msg);
      }),
    } as any as Worker;

    const workerCleanup = attachWorker(mockWorker);

    // Subscribe to observable
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-counter-stream',
      service: 'CounterChannel',
      method: 'counter$',
      args: [],
    });

    await new Promise(resolve => setTimeout(resolve, 30));

    const initialMessages = messages.length;

    // Call increment function
    workerEmitter.emit('message', {
      type: 'service-call',
      id: 'worker-counter-inc',
      service: 'CounterChannel',
      method: 'increment',
      args: [],
    });

    await new Promise(resolve => setTimeout(resolve, 30));

    // Should have both stream messages and function response
    expect(messages.length).toBeGreaterThan(initialMessages);
    
    const functionResponse = messages.find(m => m.id === 'worker-counter-inc');
    expect(functionResponse).toBeDefined();
    expect(functionResponse?.result).toBe(1);

    workerCleanup();
    cleanup();
  });
});
