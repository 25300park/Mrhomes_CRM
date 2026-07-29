export default async function globalSetup() {
  const { startServer } = require('./server.cjs') as { startServer: () => Promise<{ close: (callback: (error?: Error) => void) => void }> }
  const server = await startServer()
  return () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
