/**
 * Where ELK runs. The engine does not care: it asks for an instance and
 * awaits `layout()`. By default that is the bundled ELK on the calling thread
 * (Node, tests, a script). A browser host that would rather keep its UI
 * responsive hands over a factory once — `useElkWorker(url)` is the usual one
 * — and every layout after that runs in a Web Worker.
 *
 * The bundled ELK is loaded on first use, not on import: a page that has
 * configured a worker never pays for the 1.4 MB of algorithms twice.
 */
export interface ElkLike { layout(graph: unknown, options?: unknown): Promise<any> }

let factory: (() => ElkLike | Promise<ElkLike>) | null = null;
let instance: Promise<ElkLike> | null = null;

/** Replace how ELK instances are made. Takes effect for the next layout. */
export function configureElk(make: (() => ElkLike | Promise<ElkLike>) | null): void {
  factory = make;
  instance = null;
}

/** The shared ELK instance — created on first use, reused after. */
export function elkInstance(): Promise<ElkLike> {
  instance ??= factory
    ? Promise.resolve(factory())
    : import('elkjs/lib/elk.bundled.js').then(m => new (m.default as any)() as ElkLike);
  return instance;
}

/**
 * Run ELK in a Web Worker: `url` is where the host serves `elk-worker.min.js`
 * from elkjs. The API shim on this side is small; the algorithms load in the
 * worker, off the UI thread.
 */
export async function useElkWorker(url: string): Promise<void> {
  const { default: ELK } = await import('elkjs/lib/elk-api.js');
  configureElk(() => new (ELK as any)({ workerUrl: url }) as ElkLike);
}
