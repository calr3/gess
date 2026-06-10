// Lazy-SMP helper worker for the standalone Gess engine server.
//
// Instantiates the engine over the SHARED WebAssembly.Memory it's handed, moves
// its shadow stack to a private region, then runs search_helper() on demand to
// pound the shared transposition table while the main thread searches. Mirrors
// the browser's blob helper and verify/parallel-helper.mjs.
import { parentPort, workerData } from 'node:worker_threads';

const { wasmBytes, memory, tid } = workerData;
const imports = { env: { memory, now: () => Date.now(), random: () => Math.random() } };
const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
const ex = instance.exports;

// Private shadow stack so concurrent searches don't clobber each other in the
// shared linear memory.
ex.__stack_pointer.value = ex.thread_stack_top(tid);

parentPort.postMessage({ ready: true });
parentPort.on('message', (msg) => {
  if (msg.go) {
    ex.search_helper(msg.white, msg.budget, tid);
    parentPort.postMessage({ done: true });
  } else if (msg.exit) {
    process.exit(0);
  }
});
