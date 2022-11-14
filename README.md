# electron-ipc-cat

> Based on [frankwallis/electron-ipc-proxy](https://github.com/frankwallis/electron-ipc-proxy/pull/2), and used in [TiddlyGit-Desktop](https://github.com/tiddly-gittly/TiddlyGit-Desktop).

<p align="center" style="color: #343a40">
  <img src="docs/image/title-image.png" alt="electron-ipc-cat logo">
  <h1 align="center">electron-ipc-cat</h1>
</p>
<p align="center" style="font-size: 1.2rem;">Passing object and type between Electron main process and renderer process simply via preload script.</p>

## Overview

In latest electron, the remote module is deprecated, and you are required to passing data using IPC. But it requires tons of boilerplate code to build up IPC bridge, just like the vanilla Redux.

Luckily we have frankwallis/electron-ipc-proxy which provide a good example about how to automatically build IPC channel for a class in the main process. But it doesn't work well when we have `contextIsolation: true`, so here we have `electron-ipc-cat`!

We wrap our main process class, and can use them from the `window.xxx` in the renderer and preload script. All types are preserved, so you can get typescript intellisense just like using a local function.

## Example

Real use case in [TiddlyGit-Desktop's workspace feature](https://github.com/tiddly-gittly/TiddlyGit-Desktop/blob/master/src/services/workspaces/index.ts)

### 1. The class

```ts
/** workspaces.ts */
export class Workspace implements IWorkspaceService {
  /**
   * Record from workspace id to workspace settings
   */
  private workspaces: Record<string, IWorkspace> = {};
  public workspaces$: BehaviorSubject<Record<string, IWorkspace>>;

  public async getWorkspacesAsList(): Promise<IWorkspace[]> {
    return Object.values(this.workspaces).sort((a, b) => a.order - b.order);
  }

  public async get(id: string): Promise<IWorkspace | undefined> {
    return this.workspaces[id];
  }

  public get$(id: string): Observable<IWorkspace | undefined> {
    return this.workspaces$.pipe(map((workspaces) => workspaces[id]));
  }
}

export interface IWorkspaceService {
  workspaces$: BehaviorSubject<Record<string, IWorkspace>>;
  getWorkspacesAsList(): Promise<IWorkspace[]>;
  get(id: string): Promise<IWorkspace | undefined>;
  get$(id: string): Observable<IWorkspace | undefined>;
}

export const WorkspaceServiceIPCDescriptor = {
  channel: WorkspaceChannel.name,
  properties: {
    workspaces$: ProxyPropertyType.Value$,
    getWorkspacesAsList: ProxyPropertyType.Function,
    get: ProxyPropertyType.Function,
    get$: ProxyPropertyType.Function$,
  },
};
```

### 2. bindServiceAndProxy in Main

```ts
/** bindServiceAndProxy.ts */

/**
 * Don't forget to edit src/preload/services.ts to export service to renderer process
 */
import { registerProxy } from 'electron-ipc-cat/server';

import serviceIdentifier from '@services/serviceIdentifier';
import { container } from '@services/container';

import { Workspace } from '@services/workspaces';
import { IWorkspaceService, WorkspaceServiceIPCDescriptor } from '@services/workspaces/interface';

function bindServiceAndProxy(): void {
  // if using inversifyjs
  container.bind<IWorkspaceService>(serviceIdentifier.Workspace).to(Workspace).inSingletonScope();
  const workspaceService = container.get<IWorkspaceService>(serviceIdentifier.Workspace);
  // if using vanilla js class
  const workspaceService = new WorkspaceService();

  // register
  registerProxy(workspaceService, WorkspaceServiceIPCDescriptor);
}

bindServiceAndProxy();
```

### 3. bridge proxy in preload script

```ts
/** preload/services.ts */

/**
 * Provide API from main services to GUI (for example, preference window), and tiddlywiki
 * This file should be required by BrowserView's preload script to work
 */

import { createProxy } from 'electron-ipc-cat/client';
import { AsyncifyProxy } from 'electron-ipc-cat/common';

import { IWorkspaceService, WorkspaceServiceIPCDescriptor } from '@services/workspaces/interface';

export const workspace = createProxy<AsyncifyProxy<IWorkspaceService>>(WorkspaceServiceIPCDescriptor);

export const descriptors = {
  workspace: WorkspaceServiceIPCDescriptor,
};
```

```ts
/** preload/index.ts */
import { contextBridge } from 'electron';
import * as service from './services';

contextBridge.exposeInMainWorld('service', service);

declare global {
  interface Window {
    meta: IPossibleWindowMeta;
    observables: IServicesWithOnlyObservables<typeof service>;
    service: IServicesWithoutObservables<typeof service>;
  }
}
```

### 4. receive in Renderer

```ts
/** renderer.tsx */
import 'electron-ipc-cat/fixContextIsolation';

/** react hooks */
import { map } from 'rxjs/operators';
import { useObservable } from 'beautiful-react-hooks';

import { IWorkspace } from '@services/workspaces';

export function useWorkspacesListObservable(): IWorkspace[] | undefined {
  const [workspaces, workspacesSetter] = useState<IWorkspace[] | undefined>();
  // beware not pipe directly in the react hock, as it will re-pipe every time React reRenders, and every time regarded as new Observable, so it will re-subscribe
  // useMemo will solve this
  const workspacesList$ = useMemo(
    () => window.observables.workspace.workspaces$.pipe(map<Record<string, IWorkspace>, IWorkspace[]>((workspaces) => Object.values(workspaces))),
    [],
  );
  useObservable<IWorkspace[] | undefined>(workspacesList$, workspacesSetter);
  return workspaces;
}

export function useWorkspaceObservable(id: string): IWorkspace | undefined {
  const [workspace, workspaceSetter] = useState<IWorkspace | undefined>();
  const workspace$ = useMemo(() => window.observables.workspace.get$(id), [id]);
  useObservable<IWorkspace | undefined>(workspace$, workspaceSetter);
  return workspace;
}
```

## Notes

All `Values` and `Functions` will return promises on the renderer side, no matter how they have been defined on the source object. This is because communication happens asynchronously. For this reason it is recommended that you make them promises on the source object as well, so the interface is the same on both sides.

Use `Value$` and `Function$` when you want to expose or return an Observable stream across IPC. Due to [contextIsolation's limit](https://github.com/electron/electron/issues/28176) we can't directly proxy observables, so we have to place observables into `window.observables.xxx`.

Only plain objects can be passed between the 2 sides of the proxy, as the data is serialized to JSON, so no functions or prototypes will make it across to the other side.

Notice the second parameter of `createProxy` - `Observable` this is done so that the library itself does not need to take on a dependency to rxjs. You need to pass in the Observable constructor yourself if you want to consume Observable streams.

The channel specified must be unique and match on both sides of the proxy.

The packages exposes 2 entry points in the "main" and "browser" fields of package.json. "main" is for the main thread and "browser" is for the renderer thread.

## See it working

[Example in TiddlyGit](https://github.com/tiddly-gittly/TiddlyGit-Desktop/blob/0c6b26c0c1113e0c66d6f49f022c5733d4fa85e8/src/preload/common/services.ts#L27-L42)

## FAQ

### reject string

You should reject an Error, other wise `serialize-error` can't handle it well.

```diff
- reject(errorMessage);
+ reject(new Error(errorMessage));
```
