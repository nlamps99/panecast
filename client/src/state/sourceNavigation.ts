type Store = { selectSource(id: string, options?: { deferThreads?: boolean }): Promise<unknown>; openThread(id: string): Promise<unknown> };

/** Only the latest visible route may finish navigation or consume its parameters. */
export class SourceNavigation {
  constructor(private readonly store: Store) {}
  private generation = 0;
  active = false;
  completed: string | null = null;
  markCompleted(key: string) { this.completed = key; }
  get version(): number { return this.generation; }
  cancel(expectedVersion?: number) {
    if (expectedVersion !== undefined && expectedVersion !== this.generation) return;
    this.generation++; this.active = false;
  }
  async open(sourceId: string, threadId: string | null | undefined, complete: () => void): Promise<void> {
    const token = ++this.generation;
    this.active = true;
    try {
      await this.store.selectSource(sourceId, threadId ? { deferThreads: true } : undefined);
      if (token !== this.generation) return;
      if (threadId) await this.store.openThread(threadId);
      if (token !== this.generation) return;
      complete();
    } finally { if (token === this.generation) this.active = false; }
  }
}
