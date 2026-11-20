/**
 * Installs the replay's virtual clock (clock.ts) before pi starts: `node --import` this file.
 * The clock starts paced; the replay extension calls `go()` when the replay begins.
 */

import { busyIn, install, VirtualClock } from "./clock.ts";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetImmediate = globalThis.setImmediate;
const realNow = performance.now.bind(performance);

install(
  new VirtualClock({
    setTimeout: (callback, ms) => realSetTimeout(callback, ms).unref(),
    clearTimeout: (handle) => realClearTimeout(handle as ReturnType<typeof setTimeout>),
    setImmediate: (callback) => realSetImmediate(callback),
    now: realNow,
    busy: () => busyIn(process.getActiveResourcesInfo()),
  }),
);
