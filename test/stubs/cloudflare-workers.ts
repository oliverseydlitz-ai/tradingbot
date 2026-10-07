// Node-side stub of the `cloudflare:workers` module for unit tests.
export class WorkerEntrypoint {
  constructor(public ctx?: unknown, public env?: unknown) {}
}
export class DurableObject extends WorkerEntrypoint {}
export class RpcTarget {}
export const env = {};
export const waitUntil = () => {};
