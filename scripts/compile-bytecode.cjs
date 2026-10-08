// Runs under ELECTRON_RUN_AS_NODE: compiles a bundled script to V8 bytecode with the shipped Electron's V8.
const bytenode = require('bytenode');
const [input, output] = process.argv.slice(2);
bytenode.compileFile({ filename: input, output, electron: true }).then(() => console.log(`Bytecode: ${output}`), error => { console.error(error); process.exit(1); });
