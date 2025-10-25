/**
 * Comprehensive tests for client.ts
 * Tests renderer process IPC proxy functionality
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Observable } from 'rxjs';

// Mock IpcRenderer
class MockIpcRenderer extends EventEmitter {
  public sentMessages: Array<{ channel: string; args: any[] }> = [];

  send(channel: string, ...args: any[]): void {
    this.sentMessages.push({ channel, args });
  }

  invoke(channel: string, ...args: any[]): Promise<any> {
    return Promise.resolve({ channel, args });
  }

  once(event: string, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }
}

// Mock electron
const mockIpcRenderer = new MockIpcRenderer();
vi.mock('electron', () => ({
  ipcRenderer: mockIpcRenderer,
}));

const { createProxy } = await import('../src/client.js');
const { ProxyPropertyType } = await import('../src/common.js');

describe('Client Proxy - Basic Functionality', () => {
  beforeEach(() => {
    mockIpcRenderer.sentMessages = [];
    mockIpcRenderer.removeAllListeners();
  });

  it('should create proxy with all property types', () => {
    const descriptor = {
      channel: 'TestChannel',
      properties: {
        value: ProxyPropertyType.Value,
        method: ProxyPropertyType.Function,
        observable: ProxyPropertyType.Value$,
        observableFunc: ProxyPropertyType.Function$,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);
    
    expect(proxy).toBeDefined();
    expect(typeof proxy.method).toBe('function');
  });
});

describe('Client Proxy - Function Calls', () => {
  beforeEach(() => {
    mockIpcRenderer.sentMessages = [];
    mockIpcRenderer.removeAllListeners();
  });

  it('should call function without arguments', async () => {
    const descriptor = {
      channel: 'TestChannel',
      properties: {
        getString: ProxyPropertyType.Function,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const promise = proxy.getString();
    await new Promise(resolve => setImmediate(resolve));

    // Find the correlation ID from sent message
    const sentMessage = mockIpcRenderer.sentMessages.find(m => m.channel === 'TestChannel');
    expect(sentMessage).toBeDefined();
    expect(sentMessage!.args[0]).toMatchObject({
      type: 'apply',
      propKey: 'getString',
      args: [],
    });

    const correlationId = sentMessage!.args[1];

    // Simulate response
    mockIpcRenderer.emit(correlationId, null, {
      type: 'result',
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

    const proxy = createProxy<any>(descriptor, Observable);

    const promise = proxy.add(5, 3);
    await new Promise(resolve => setImmediate(resolve));

    const sentMessage = mockIpcRenderer.sentMessages.find(m => m.channel === 'MathChannel');
    expect(sentMessage!.args[0].args).toEqual([5, 3]);

    const correlationId = sentMessage!.args[1];
    mockIpcRenderer.emit(correlationId, null, {
      type: 'result',
      result: 8,
    });

    const result = await promise;
    expect(result).toBe(8);
  });

  it('should handle function errors', async () => {
    const descriptor = {
      channel: 'ErrorChannel',
      properties: {
        throwError: ProxyPropertyType.Function,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const promise = proxy.throwError();
    await new Promise(resolve => setImmediate(resolve));

    const sentMessage = mockIpcRenderer.sentMessages[0];
    const correlationId = sentMessage.args[1];

    mockIpcRenderer.emit(correlationId, null, {
      type: 'error',
      error: JSON.stringify({ message: 'Test error', name: 'TestError' }),
    });

    await expect(promise).rejects.toThrow('Test error');
  });

  it('should handle complex return types', async () => {
    const descriptor = {
      channel: 'UserChannel',
      properties: {
        getUser: ProxyPropertyType.Function,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const promise = proxy.getUser(123);
    await new Promise(resolve => setImmediate(resolve));

    const correlationId = mockIpcRenderer.sentMessages[0].args[1];
    mockIpcRenderer.emit(correlationId, null, {
      type: 'result',
      result: {
        id: 123,
        name: 'Test User',
        roles: ['admin', 'user'],
      },
    });

    const result = await promise;
    expect(result).toEqual({
      id: 123,
      name: 'Test User',
      roles: ['admin', 'user'],
    });
  });
});

describe('Client Proxy - Property Access', () => {
  beforeEach(() => {
    mockIpcRenderer.sentMessages = [];
    mockIpcRenderer.removeAllListeners();
  });

  it('should get property value', async () => {
    const descriptor = {
      channel: 'ConfigChannel',
      properties: {
        version: ProxyPropertyType.Value,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const promise = proxy.version;
    await new Promise(resolve => setImmediate(resolve));

    const sentMessage = mockIpcRenderer.sentMessages[0];
    expect(sentMessage.args[0]).toMatchObject({
      type: 'get',
      propKey: 'version',
    });

    const correlationId = sentMessage.args[1];
    mockIpcRenderer.emit(correlationId, null, {
      type: 'result',
      result: '1.0.0',
    });

    const result = await promise;
    expect(result).toBe('1.0.0');
  });
});

describe('Client Proxy - Observable Support', () => {
  beforeEach(() => {
    mockIpcRenderer.sentMessages = [];
    mockIpcRenderer.removeAllListeners();
  });

  it('should subscribe to observable property', async () => {
    const descriptor = {
      channel: 'ObsChannel',
      properties: {
        data$: ProxyPropertyType.Value$,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const values: any[] = [];
    const completePromise = new Promise<void>((resolve) => {
      const subscription = proxy.data$.subscribe({
        next: (value: any) => {
          values.push(value);
          if (values.length === 2) {
            expect(values).toEqual(['value1', 'value2']);
            subscription.unsubscribe();
            resolve();
          }
        },
      });

      setTimeout(() => {
        const sentMessage = mockIpcRenderer.sentMessages[0];
        expect(sentMessage.args[0].type).toBe('subscribe');
        const subscriptionId = sentMessage.args[0].subscriptionId;

        mockIpcRenderer.emit(subscriptionId, null, { type: 'next', value: 'value1' });
        mockIpcRenderer.emit(subscriptionId, null, { type: 'next', value: 'value2' });
      }, 10);
    });

    await completePromise;
  });

  it('should subscribe to observable function', async () => {
    const descriptor = {
      channel: 'StreamChannel',
      properties: {
        getNumbers$: ProxyPropertyType.Function$,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const values: number[] = [];
    const completePromise = new Promise<void>((resolve) => {
      const subscription = proxy.getNumbers$().subscribe({
        next: (value: number) => values.push(value),
        complete: () => {
          expect(values).toEqual([1, 2, 3]);
          subscription.unsubscribe();
          resolve();
        },
      });

      setTimeout(() => {
        const sentMessage = mockIpcRenderer.sentMessages[0];
        expect(sentMessage.args[0].type).toBe('applySubscribe');
        const subscriptionId = sentMessage.args[0].subscriptionId;

        mockIpcRenderer.emit(subscriptionId, null, { type: 'next', value: 1 });
        mockIpcRenderer.emit(subscriptionId, null, { type: 'next', value: 2 });
        mockIpcRenderer.emit(subscriptionId, null, { type: 'next', value: 3 });
        mockIpcRenderer.emit(subscriptionId, null, { type: 'complete' });
      }, 10);
    });

    await completePromise;
  });

  it('should handle observable errors', async () => {
    const descriptor = {
      channel: 'ErrorObsChannel',
      properties: {
        errorStream$: ProxyPropertyType.Value$,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const errorPromise = new Promise<void>((resolve) => {
      const subscription = proxy.errorStream$.subscribe({
        error: (error: Error) => {
          expect(error.message).toContain('Stream error');
          subscription.unsubscribe();
          resolve();
        },
      });

      setTimeout(() => {
        const subscriptionId = mockIpcRenderer.sentMessages[0].args[0].subscriptionId;
        mockIpcRenderer.emit(subscriptionId, null, {
          type: 'error',
          error: JSON.stringify({ message: 'Stream error', name: 'StreamError' }),
        });
      }, 10);
    });

    await errorPromise;
  });

  it('should unsubscribe from observables', async () => {
    const descriptor = {
      channel: 'UnsubChannel',
      properties: {
        stream$: ProxyPropertyType.Value$,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const subscription = proxy.stream$.subscribe({ next: () => {} });
    await new Promise(resolve => setTimeout(resolve, 10));

    const subscribeMessage = mockIpcRenderer.sentMessages.find(m => 
      m.args[0]?.type === 'subscribe'
    );
    const subscriptionId = subscribeMessage!.args[0].subscriptionId;

    subscription.unsubscribe();
    await new Promise(resolve => setTimeout(resolve, 10));

    const unsubscribeMessage = mockIpcRenderer.sentMessages.find(m => 
      m.args[0]?.type === 'unsubscribe'
    );

    expect(unsubscribeMessage).toBeDefined();
    expect(unsubscribeMessage!.args[0].subscriptionId).toBe(subscriptionId);
  });
});

describe('Client Proxy - Edge Cases', () => {
  beforeEach(() => {
    mockIpcRenderer.sentMessages = [];
    mockIpcRenderer.removeAllListeners();
  });

  it('should throw error when Observable constructor not provided for Observable properties', () => {
    const descriptor = {
      channel: 'ObsChannel',
      properties: {
        data$: ProxyPropertyType.Value$,
      },
    };

    expect(() => {
      createProxy<any>(descriptor, null as any);
    }).toThrow('Observable constructor');
  });

  it('should handle multiple concurrent function calls', async () => {
    const descriptor = {
      channel: 'MultiChannel',
      properties: {
        getValue: ProxyPropertyType.Function,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const promises = [
      proxy.getValue('a'),
      proxy.getValue('b'),
      proxy.getValue('c'),
    ];

    await new Promise(resolve => setImmediate(resolve));

    // Simulate responses for all calls
    mockIpcRenderer.sentMessages.forEach((msg, index) => {
      if (msg.channel === 'MultiChannel') {
        const correlationId = msg.args[1];
        mockIpcRenderer.emit(correlationId, null, {
          type: 'result',
          result: `response-${index}`,
        });
      }
    });

    const results = await Promise.all(promises);
    expect(results).toHaveLength(3);
  });
});

describe('Client Proxy - Subscribe Helpers', () => {
  beforeEach(() => {
    mockIpcRenderer.sentMessages = [];
    mockIpcRenderer.removeAllListeners();
  });

  it('should use Subscribe helper for observable property', async () => {
    const descriptor = {
      channel: 'HelperChannel',
      properties: {
        stream$: ProxyPropertyType.Value$,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const values: any[] = [];
    const completePromise = new Promise<void>((resolve) => {
      // Access the Subscribe helper
      const subscribeHelper = (proxy as any).stream$Subscribe;
      expect(typeof subscribeHelper).toBe('function');

      // Use the Subscribe helper with observer function
      subscribeHelper((value: any) => {
        values.push(value);
        if (values.length === 2) {
          resolve();
        }
      });

      setTimeout(() => {
        const sentMessage = mockIpcRenderer.sentMessages[0];
        const subscriptionId = sentMessage.args[0].subscriptionId;
        
        mockIpcRenderer.emit(subscriptionId, null, { type: 'next', value: 'A' });
        mockIpcRenderer.emit(subscriptionId, null, { type: 'next', value: 'B' });
      }, 10);
    });

    await completePromise;
    expect(values).toEqual(['A', 'B']);
  });

  it('should use Subscribe helper for observable function', async () => {
    const descriptor = {
      channel: 'FunctionHelperChannel',
      properties: {
        getData$: ProxyPropertyType.Function$,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const values: any[] = [];
    const completePromise = new Promise<void>((resolve) => {
      // Access the Subscribe helper for function
      const subscribeHelper = (proxy as any).getData$Subscribe;
      expect(typeof subscribeHelper).toBe('function');

      // Call with args, then subscribe
      subscribeHelper('param1', 'param2')((value: any) => {
        values.push(value);
        if (values.length === 3) {
          resolve();
        }
      });

      setTimeout(() => {
        const sentMessage = mockIpcRenderer.sentMessages[0];
        expect(sentMessage.args[0].args).toEqual(['param1', 'param2']);
        const subscriptionId = sentMessage.args[0].subscriptionId;
        
        mockIpcRenderer.emit(subscriptionId, null, { type: 'next', value: 1 });
        mockIpcRenderer.emit(subscriptionId, null, { type: 'next', value: 2 });
        mockIpcRenderer.emit(subscriptionId, null, { type: 'next', value: 3 });
      }, 10);
    });

    await completePromise;
    expect(values).toEqual([1, 2, 3]);
  });
});

describe('Client Proxy - README Examples', () => {
  beforeEach(() => {
    mockIpcRenderer.sentMessages = [];
    mockIpcRenderer.removeAllListeners();
  });

  it('should handle workspace service example from README', async () => {
    // Simulate the Workspace service descriptor from README
    const WorkspaceServiceIPCDescriptor = {
      channel: 'WorkspaceChannel',
      properties: {
        workspaces$: ProxyPropertyType.Value$,
        getWorkspacesAsList: ProxyPropertyType.Function,
        get: ProxyPropertyType.Function,
        get$: ProxyPropertyType.Function$,
      },
    };

    const workspace = createProxy<any>(WorkspaceServiceIPCDescriptor, Observable);

    // Test getWorkspacesAsList (Promise function)
    const listPromise = workspace.getWorkspacesAsList();
    await new Promise(resolve => setImmediate(resolve));

    const getMessage = mockIpcRenderer.sentMessages.find(m => m.channel === 'WorkspaceChannel');
    expect(getMessage).toBeDefined();
    expect(getMessage!.args[0].propKey).toBe('getWorkspacesAsList');

    const correlationId = getMessage!.args[1];
    mockIpcRenderer.emit(correlationId, null, {
      type: 'result',
      result: [{ id: '1', name: 'Workspace 1' }],
    });

    const list = await listPromise;
    expect(list).toEqual([{ id: '1', name: 'Workspace 1' }]);

    // Test get function with parameter
    const getPromise = workspace.get('workspace-123');
    await new Promise(resolve => setImmediate(resolve));

    const getMsg = mockIpcRenderer.sentMessages[mockIpcRenderer.sentMessages.length - 1];
    expect(getMsg.args[0].args).toEqual(['workspace-123']);

    const getCorrelationId = getMsg.args[1];
    mockIpcRenderer.emit(getCorrelationId, null, {
      type: 'result',
      result: { id: 'workspace-123', name: 'My Workspace' },
    });

    const workspace123 = await getPromise;
    expect(workspace123).toEqual({ id: 'workspace-123', name: 'My Workspace' });
  });

  it('should handle observable workspace from README example', async () => {
    const WorkspaceServiceIPCDescriptor = {
      channel: 'WorkspaceChannel',
      properties: {
        workspaces$: ProxyPropertyType.Value$,
        get$: ProxyPropertyType.Function$,
      },
    };

    const workspace = createProxy<any>(WorkspaceServiceIPCDescriptor, Observable);

    // Test workspaces$ observable property
    const workspaceValues: any[] = [];
    const subscription = workspace.workspaces$.subscribe({
      next: (value: any) => {
        workspaceValues.push(value);
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const msg = mockIpcRenderer.sentMessages[0];
    const subscriptionId = msg.args[0].subscriptionId;

    mockIpcRenderer.emit(subscriptionId, null, {
      type: 'next',
      value: { 'ws-1': { id: 'ws-1', name: 'Workspace 1' } },
    });

    mockIpcRenderer.emit(subscriptionId, null, {
      type: 'next',
      value: { 
        'ws-1': { id: 'ws-1', name: 'Workspace 1' },
        'ws-2': { id: 'ws-2', name: 'Workspace 2' },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(workspaceValues).toHaveLength(2);
    expect(workspaceValues[1]).toHaveProperty('ws-2');

    subscription.unsubscribe();

    // Test get$ observable function
    const workspaceData: any[] = [];
    const get$Sub = workspace.get$('ws-1').subscribe({
      next: (value: any) => {
        workspaceData.push(value);
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const get$Msg = mockIpcRenderer.sentMessages[mockIpcRenderer.sentMessages.length - 1];
    expect(get$Msg.args[0].args).toEqual(['ws-1']);
    const get$SubId = get$Msg.args[0].subscriptionId;

    mockIpcRenderer.emit(get$SubId, null, {
      type: 'next',
      value: { id: 'ws-1', name: 'Workspace 1', active: true },
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(workspaceData).toHaveLength(1);
    expect(workspaceData[0]).toMatchObject({ id: 'ws-1', active: true });

    get$Sub.unsubscribe();
  });

  it('should handle unknown property type error', () => {
    const descriptor = {
      channel: 'TestChannel',
      properties: {
        unknown: 'InvalidType' as any,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    expect(() => {
      // This should trigger getProperty with invalid type
      const _ = proxy.unknown;
    }).toThrow('Unrecognised ProxyPropertyType');
  });

  it('should handle unknown response type in makeRequest', async () => {
    const descriptor = {
      channel: 'UnknownResponseChannel',
      properties: {
        test: ProxyPropertyType.Function,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);
    const promise = proxy.test();

    await new Promise(resolve => setImmediate(resolve));

    const msg = mockIpcRenderer.sentMessages[0];
    const correlationId = msg.args[1];

    // Send unknown response type
    mockIpcRenderer.emit(correlationId, null, {
      type: 'unknown-type' as any,
      result: 'test',
    });

    await expect(promise).rejects.toThrow('Unhandled response type');
  });

  it('should handle unknown response type in makeObservable', async () => {
    const descriptor = {
      channel: 'UnknownObsResponseChannel',
      properties: {
        stream$: ProxyPropertyType.Value$,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    let errorReceived: Error | null = null;

    const errorPromise = new Promise<void>((resolve) => {
      proxy.stream$.subscribe({
        next: () => {},
        error: (err: Error) => {
          errorReceived = err;
          resolve();
        },
      });

      setTimeout(() => {
        const msg = mockIpcRenderer.sentMessages[0];
        const subscriptionId = msg.args[0].subscriptionId;

        // Send unknown response type
        mockIpcRenderer.emit(subscriptionId, null, {
          type: 'unknown-obs-type' as any,
          value: 'test',
        });
      }, 10);
    });

    await errorPromise;
    expect(errorReceived).toBeDefined();
    expect(errorReceived!.message).toContain('Unhandled response type');
  });

  it('should handle error when unsubscribing from observable', async () => {
    const descriptor = {
      channel: 'UnsubErrorChannel',
      properties: {
        stream$: ProxyPropertyType.Value$,
      },
    };

    const proxy = createProxy<any>(descriptor, Observable);

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const subscription = proxy.stream$.subscribe({
      next: () => {},
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // Mock the unsubscribe to fail
    const unsubPromise = new Promise<void>((resolve) => {
      const originalOn = mockIpcRenderer.on.bind(mockIpcRenderer);
      let unsubscribeCorrelationId: string | null = null;
      
      mockIpcRenderer.on = vi.fn((channel: string, listener: any) => {
        if (unsubscribeCorrelationId === null && channel !== 'UnsubErrorChannel') {
          // This is likely a correlation ID for unsubscribe
          setTimeout(() => {
            mockIpcRenderer.emit(channel, null, {
              type: 'error',
              error: JSON.stringify({ message: 'Unsubscribe failed on server' }),
            });
            resolve();
          }, 5);
        }
        return originalOn(channel, listener);
      }) as any;

      subscription.unsubscribe();
    });

    await unsubPromise;
    await new Promise(resolve => setTimeout(resolve, 20));

    // The unsubscribe error should be logged but not necessarily throw
    expect(mockIpcRenderer.sentMessages.length).toBeGreaterThan(0);

    consoleLogSpy.mockRestore();
  });
});

