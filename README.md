# electron-ipc-cat

> Based on [frankwallis/electron-ipc-proxy](https://github.com/frankwallis/electron-ipc-proxy/pull/2), and used in [TiddlyGit-Desktop](https://github.com/tiddly-gittly/TiddlyGit-Desktop).

Passing object and type between Electron main process and renderer process simply via preload script.

## Overview

## Example

## Notes

All `Values` and `Functions` will return promises on the renderer side, no matter how they have been defined on the source object. This is because communication happens asynchronously. For this reason it is recommended that you make them promises on the source object as well, so the interface is the same on both sides.

Use `Value$` and `Function$` when you want to expose or return an Observable stream across IPC.

Only plain objects can be passed between the 2 sides of the proxy, as the data is serialized to JSON, so no functions or prototypes will make it across to the other side.

Notice the second parameter of `createProxy` - `Observable` this is done so that the library itself does not need to take on a dependency to rxjs. You need to pass in the Observable constructor yourself if you want to consume Observable streams.

The channel specified must be unique and match on both sides of the proxy.

The packages exposes 2 entry points in the "main" and "browser" fields of package.json. "main" is for the main thread and "browser" is for the renderer thread.

## See it working

[Example in TiddlyGit](https://github.com/tiddly-gittly/TiddlyGit-Desktop/blob/0c6b26c0c1113e0c66d6f49f022c5733d4fa85e8/src/preload/common/services.ts#L27-L42)
