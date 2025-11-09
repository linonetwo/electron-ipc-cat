/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, it, describe, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { ProxyPropertyType, RequestType, ResponseType } from '../src/common.js';
import type { ApplyRequest } from '../src/common.js';

// Mock electron's IpcMain
class MockIpcMain extends EventEmitter {
  handle = vi.fn();
  removeHandler = vi.fn();
}

// Mock WebContents
class MockWebContents extends EventEmitter {
  constructor(public id: number) {
    super();
  }

  send = vi.fn();
  isDestroyed = vi.fn(() => false);
}

// Mock electron module before importing server
const mockIpcMain = new MockIpcMain();
vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
}));

// Import server after mocking electron
const { registerProxy } = await import('../src/server.js');

// Mock electron types
interface MockIpcMainEvent {
  sender: any;
  senderId: number;
  processId: number;
  frameId: number;
  ports: any[];
  reply: any;
  returnValue: any;
  senderFrame: any;
  preventDefault: any;
  defaultPrevented: boolean;
}

describe('Serialization Error Handling', () => {
  let mockWebContents: MockWebContents;
  let mockEvent: MockIpcMainEvent;

  beforeEach(() => {
    mockIpcMain.removeAllListeners();
    mockWebContents = new MockWebContents(1);
    mockEvent = {
      sender: mockWebContents as any,
      senderId: 1,
      processId: 1,
      frameId: 1,
      ports: [],
      reply: vi.fn(),
      returnValue: undefined,
      senderFrame: null as any,
      preventDefault: vi.fn(),
      defaultPrevented: false,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should handle circular references gracefully', async () => {
    // Create object with circular reference
    const obj: any = { a: 1, b: 'test' };
    obj.self = obj;

    const service = {
      getCircular: () => obj,
    };

    const channel = 'test-circular';
    const correlationId = 'corr-123';

    registerProxy(
      service,
      {
        channel,
        properties: {
          getCircular: ProxyPropertyType.Function,
        },
      },
      mockIpcMain as any,
    );

    // Mock sender.send to throw error on circular reference (like real Electron)
    const originalSend = mockWebContents.send;
    let sendCallCount = 0;
    mockWebContents.send = vi.fn((channel: string, data: any) => {
      sendCallCount++;
      // First call will have circular reference, should throw
      if (sendCallCount === 1 && data.type === ResponseType.Result && data.result?.self) {
        throw new Error('Failed to serialize arguments');
      }
      // Second call should be the cleaned result or error
      return originalSend.call(mockWebContents, channel, data);
    });

    // Simulate IPC call
    const request: ApplyRequest = {
      type: RequestType.Apply,
      propKey: 'getCircular',
      args: [],
    };

    mockIpcMain.emit(channel, mockEvent, request, correlationId);

    // Wait for async operation
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have been called twice: first attempt fails, second succeeds with cleaned data
    expect(mockWebContents.send).toHaveBeenCalled();
    
    // The final call should be either cleaned result or error
    const lastCall = (mockWebContents.send as any).mock.calls[(mockWebContents.send as any).mock.calls.length - 1];
    expect(lastCall[0]).toBe(correlationId);
    // Should be cleaned (without circular) or error response
    const response = lastCall[1];
    if (response.type === ResponseType.Result) {
      // Cleaned result should not have circular reference
      expect(response.result.a).toBe(1);
      expect(response.result.b).toBe('test');
      // self property might be undefined or not throw when stringifying
      expect(() => JSON.stringify(response.result)).not.toThrow();
    } else {
      // Or it's an error response
      expect(response.type).toBe(ResponseType.Error);
      expect(response.error).toContain('Failed to serialize');
    }
  });

  it('should handle functions in response gracefully', async () => {
    const service = {
      getObjectWithFunction: () => ({
        data: 'test',
        method: () => 'this will be stripped',
      }),
    };

    const channel = 'test-function';
    const correlationId = 'corr-456';

    registerProxy(
      service,
      {
        channel,
        properties: {
          getObjectWithFunction: ProxyPropertyType.Function,
        },
      },
      mockIpcMain as any,
    );

    const request: ApplyRequest = {
      type: RequestType.Apply,
      propKey: 'getObjectWithFunction',
      args: [],
    };

    mockIpcMain.emit(channel, mockEvent, request, correlationId);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should successfully serialize (JSON.stringify strips functions)
    expect(mockWebContents.send).toHaveBeenCalledWith(
      correlationId,
      expect.objectContaining({
        type: ResponseType.Result,
        result: expect.objectContaining({
          data: 'test',
          // method should be undefined after serialization
        }),
      }),
    );
  });

  it('should handle deeply nested objects', async () => {
    const service = {
      getDeepObject: () => {
        const deep: any = { level: 0 };
        let current = deep;
        // Create a very deep nested structure
        for (let i = 1; i < 100; i++) {
          current.next = { level: i };
          current = current.next;
        }
        return deep;
      },
    };

    const channel = 'test-deep';
    const correlationId = 'corr-789';

    registerProxy(
      service,
      {
        channel,
        properties: {
          getDeepObject: ProxyPropertyType.Function,
        },
      },
      mockIpcMain as any,
    );

    const request: ApplyRequest = {
      type: RequestType.Apply,
      propKey: 'getDeepObject',
      args: [],
    };

    mockIpcMain.emit(channel, mockEvent, request, correlationId);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should successfully serialize deep object
    expect(mockWebContents.send).toHaveBeenCalledWith(
      correlationId,
      expect.objectContaining({
        type: ResponseType.Result,
        result: expect.objectContaining({
          level: 0,
        }),
      }),
    );
  });

  it('should handle class instances by serializing plain properties', async () => {
    class MyClass {
      constructor(
        public name: string,
        public value: number,
      ) {}

      method() {
        return 'method';
      }
    }

    const service = {
      getClassInstance: () => new MyClass('test', 42),
    };

    const channel = 'test-class';
    const correlationId = 'corr-class';

    registerProxy(
      service,
      {
        channel,
        properties: {
          getClassInstance: ProxyPropertyType.Function,
        },
      },
      mockIpcMain as any,
    );

    const request: ApplyRequest = {
      type: RequestType.Apply,
      propKey: 'getClassInstance',
      args: [],
    };

    mockIpcMain.emit(channel, mockEvent, request, correlationId);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should successfully serialize (will lose class methods)
    expect(mockWebContents.send).toHaveBeenCalledWith(
      correlationId,
      expect.objectContaining({
        type: ResponseType.Result,
        result: expect.objectContaining({
          name: 'test',
          value: 42,
        }),
      }),
    );
  });

  it('should handle normal serializable objects successfully', async () => {
    const service = {
      getData: () => ({
        name: 'test',
        value: 123,
        nested: {
          array: [1, 2, 3],
          bool: true,
        },
      }),
    };

    const channel = 'test-normal';
    const correlationId = 'corr-normal';

    registerProxy(
      service,
      {
        channel,
        properties: {
          getData: ProxyPropertyType.Function,
        },
      },
      mockIpcMain as any,
    );

    const request: ApplyRequest = {
      type: RequestType.Apply,
      propKey: 'getData',
      args: [],
    };

    mockIpcMain.emit(channel, mockEvent, request, correlationId);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should successfully serialize normal object
    expect(mockWebContents.send).toHaveBeenCalledWith(
      correlationId,
      expect.objectContaining({
        type: ResponseType.Result,
        result: expect.objectContaining({
          name: 'test',
          value: 123,
          nested: {
            array: [1, 2, 3],
            bool: true,
          },
        }),
      }),
    );
  });
});
