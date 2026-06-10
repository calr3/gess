// A Lazy-SMP helper worker for the parallel verification (verify/parallel.mjs).
// Instantiates the engine over the SHARED memory, relocates its shadow stack to
// its private region, then runs search_helper() on demand to pound the shared TT.
import { parentPort, workerData } from 'node:worker_threads';

const { wasmBytes, memory, tid } = workerData;
const imports = { env: { memory, now: () => Date.now(), random: () => Math.random() } };
const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
const ex = instance.exports;

// Give this worker its own shadow stack so concurrent searches don't clobber the
// main worker's (or each other's) stack in the shared linear memory.
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
