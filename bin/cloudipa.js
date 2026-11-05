#!/usr/bin/env node
const path = require('path');

const cliPath = path.resolve(__dirname, '../dist/cli.js');
try {
  const { createCli } = require(cliPath);
  const cli = createCli();
  cli.parse(process.argv);
} catch (err) {
  if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(cliPath)) {
    console.error('Error: CloudIPA has not been built yet. Run "npm run build" first.');
    process.exit(1);
  }
  throw err;
}
