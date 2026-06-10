// Embeds the compiled .wasm as a base64 string in a TypeScript module, so the
// engine travels inside the JS bundle (no separate asset / fetch / URL handling
// needed by the Angular builder, and it loads identically in a module worker).
//
// Run after `cargo build --release --target wasm32-unknown-unknown`.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dirname, 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const outPath = join(__dirname, '..', 'src', 'app', 'services', 'gess-wasm.generated.ts');

const bytes = readFileSync(wasmPath);
const b64 = bytes.toString('base64');

const content = `// AUTO-GENERATED — do not edit by hand.
// Produced by wasm-engine/embed.mjs from the Rust AI engine (gess-engine-wasm).
// Rebuild with: wasm-engine/build.sh
//
// The Gess AI search engine, compiled to WebAssembly, base64-encoded so it ships
// inside the JS bundle. ${bytes.length} bytes.
/* eslint-disable */
export const GESS_WASM_BASE64 =
  '${b64}';
`;

writeFileSync(outPath, content);
console.log(`Embedded ${bytes.length} bytes → ${outPath}`);
