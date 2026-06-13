import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This project lives inside ~/dev alongside other lockfiles; pin the tracing
  // root to this directory so Next doesn't pick up a sibling package-lock.json.
  outputFileTracingRoot: __dirname,
  // Produce a minimal self-contained server bundle under .next/standalone
  // (with only the needed node_modules). This is what the Docker image copies,
  // so we don't ship the full node_modules into the container.
  output: 'standalone',
};

export default nextConfig;
