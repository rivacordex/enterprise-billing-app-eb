// Vitest never sets the "react-server" export condition Next's bundler uses
// to make the real `server-only` package a no-op — without this alias,
// importing any file with `import "server-only"` (e.g. lib/temp-password.ts)
// throws unconditionally (node_modules/server-only/index.js) under both the
// jsdom and node Vitest environments.
export {};
