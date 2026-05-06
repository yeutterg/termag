const fs = require('node:fs');
const path = require('node:path');

fs.rmSync(path.join(__dirname, '..', '.next'), { recursive: true, force: true });
require('../server');
