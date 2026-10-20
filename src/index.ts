#!/usr/bin/env node
import { run } from './cli.js';

const [major] = process.versions.node.split('.').map(Number);
if ((major ?? 0) < 18) {
    process.stderr.write(`aclclouds needs Node.js 18 or newer (you have ${process.version}).\n`);
    process.exit(1);
}

await run(process.argv);
