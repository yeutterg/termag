const fs = require('node:fs');
const path = require('node:path');

// Pre-load .env.local / .env so server.js's boot-time security checks
// (trusted-network bind, NEXTAUTH_SECRET) see the same env Next.js
// would. Next.js loads env inside app.prepare(), which runs AFTER our
// custom server's startup gate. Without this, a dev with valid
// .env.local hits "NEXTAUTH_SECRET missing" on every start.
const { loadEnvConfig } = require('@next/env');
loadEnvConfig(path.join(__dirname, '..'));

fs.rmSync(path.join(__dirname, '..', '.next'), { recursive: true, force: true });
require('../server');
