/**
 * Edge cases and error handling tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { BehaviorSubject, Subject } from 'rxjs';

// Mock IpcMain and WebContents
class MockIpcMain extends EventEmitter {
  public handlers = new Map<string, any>();

  on(channel: string, listener: any): this {
    this.handlers.set(channel, listener);
    return super.on(channel, listener);
  }

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

const mockIpcMain = new MockIpcMain();

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
}));

const { registerProxy } = await import('../src/server.js');
const { ProxyPropertyType, RequestType, ResponseType } = await import('../src/common.js');

describe('Server - Edge Cases and Error Handling', () => {
  beforeEach(() => {
    mockIpcMain.handlers.clear();
  });

  it('should handle JSON.stringify error for request', async () => {
    const service = {
      failMethod: async () => {
        throw new Error('Method failed');
      },
    };

    const descriptor = {
      channel: 'JSONErrorChannel',
      properties: {
        failMethod: ProxyPropertyType.Function,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);
    const handler = mockIpcMain.handlers.get('JSONErrorChannel')!;
    const sender = new MockWebContents();
    const event = new MockIpcMainEvent(sender);

    // Create a request that can't be stringified (circular reference)
    const circularRequest: any = {
      type: RequestType.Apply,
      propKey: 'failMethod',
      args: [],
    };
    circularRequest.circular = circularRequest;

    await handler(event, circularRequest, 'correlation-json-err');
    await new Promise(resolve => setImmediate(resolve));

    // Should still send error response
    expect(sender.messages.length).toBeGreaterThan(0);
    expect(sender.messages[0].data.type).toBe(ResponseType.Error);

    cleanup();
  });

  it('should throw error when unsubscribing non-existent subscription', async () => {
    const subject = new Subject<number>();
    const service = {
      data$: subject,
    };

    const descriptor = {
      channel: 'UnsubNonExistentChannel',
      properties: {
        data$: ProxyPropertyType.Value$,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);
    const handler = mockIpcMain.handlers.get('UnsubNonExistentChannel')!;
    const sender = new MockWebContents();
    const event = new MockIpcMainEvent(sender);

    // Try to unsubscribe a non-existent subscription
    await handler(event, {
      type: RequestType.Unsubscribe,
      subscriptionId: 'non-existent-sub',
    }, 'correlation-unsub-err');

    await new Promise(resolve => setImmediate(resolve));

    expect(sender.messages[0].data.type).toBe(ResponseType.Error);
    expect(sender.messages[0].data.error).toContain('does not exist');

    cleanup();
  });

  it('should throw error for duplicate subscription ID', async () => {
    const subject = new BehaviorSubject<number>(0);
    const service = {
      data$: subject,
    };

    const descriptor = {
      channel: 'DuplicateSubChannel',
      properties: {
        data$: ProxyPropertyType.Value$,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);
    const handler = mockIpcMain.handlers.get('DuplicateSubChannel')!;
    const sender = new MockWebContents();
    const event = new MockIpcMainEvent(sender);

    const subscriptionId = 'duplicate-sub-id';

    // First subscription
    await handler(event, {
      type: RequestType.Subscribe,
      propKey: 'data$',
      subscriptionId,
    }, 'correlation-dup-1');

    await new Promise(resolve => setImmediate(resolve));

    // Try to subscribe with same ID again
    await handler(event, {
      type: RequestType.Subscribe,
      propKey: 'data$',
      subscriptionId,
    }, 'correlation-dup-2');

    await new Promise(resolve => setImmediate(resolve));

    // Should have error response
    const errorMsg = sender.messages.find((m: any) => m.data.type === ResponseType.Error);
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.data.error).toContain('already exists');

    cleanup();
  });

  it('should throw error when ApplySubscribe called on non-function', async () => {
    const service = {
      notAFunction$: 'just a string',
    };

    const descriptor = {
      channel: 'ApplySubNotFuncChannel',
      properties: {
        notAFunction$: ProxyPropertyType.Function$,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);
    const handler = mockIpcMain.handlers.get('ApplySubNotFuncChannel')!;
    const sender = new MockWebContents();
    const event = new MockIpcMainEvent(sender);

    await handler(event, {
      type: RequestType.ApplySubscribe,
      propKey: 'notAFunction$',
      subscriptionId: 'sub-not-func',
      args: [],
    }, 'correlation-apply-sub-err');

    await new Promise(resolve => setImmediate(resolve));

    expect(sender.messages[0].data.type).toBe(ResponseType.Error);
    expect(sender.messages[0].data.error).toContain('is not a function');

    cleanup();
  });

  it('should throw error when ApplySubscribe returns non-observable', async () => {
    const service = {
      returnsString: () => 'not an observable' as any,
    };

    const descriptor = {
      channel: 'ApplySubNotObsChannel',
      properties: {
        returnsString: ProxyPropertyType.Function$,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);
    const handler = mockIpcMain.handlers.get('ApplySubNotObsChannel')!;
    const sender = new MockWebContents();
    const event = new MockIpcMainEvent(sender);

    await handler(event, {
      type: RequestType.ApplySubscribe,
      propKey: 'returnsString',
      subscriptionId: 'sub-not-obs',
      args: [],
    }, 'correlation-apply-sub-obs-err');

    await new Promise(resolve => setImmediate(resolve));

    expect(sender.messages[0].data.type).toBe(ResponseType.Error);
    expect(sender.messages[0].data.error).toContain('did not return an observable');

    cleanup();
  });

  it('should throw error for invalid subscriptionId type in ApplySubscribe', async () => {
    const service = {
      getData$: () => new Subject<number>(),
    };

    const descriptor = {
      channel: 'InvalidSubIdApplyChannel',
      properties: {
        getData$: ProxyPropertyType.Function$,
      },
    };

    const cleanup = registerProxy(service, descriptor, mockIpcMain as any);
    const handler = mockIpcMain.handlers.get('InvalidSubIdApplyChannel')!;
    const sender = new MockWebContents();
    const event = new MockIpcMainEvent(sender);

    await handler(event, {
      type: RequestType.ApplySubscribe,
      propKey: 'getData$',
      subscriptionId: 123 as any, // Invalid: should be string
      args: [],
    }, 'correlation-invalid-subid-apply');

    await new Promise(resolve => setImmediate(resolve));

    expect(sender.messages[0].data.type).toBe(ResponseType.Error);
    expect(sender.messages[0].data.error).toContain('is not a string');

    cleanup();
  });
});
