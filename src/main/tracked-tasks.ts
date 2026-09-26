export class TrackedTaskRegistry {
  private readonly active = new Set<Promise<unknown>>()
  private shuttingDown = false

  start<T>(task: () => Promise<T> | T): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error('应用正在退出，无法开始新的写操作'))
    const operation = Promise.resolve().then(task)
    let tracked: Promise<T>
    tracked = operation.finally(() => {
      this.active.delete(tracked)
    })
    this.active.add(tracked)
    return tracked
  }

  beginShutdown(): void {
    this.shuttingDown = true
  }

  isShuttingDown(): boolean {
    return this.shuttingDown
  }

  pendingCount(): number {
    return this.active.size
  }

  async drain(): Promise<void> {
    // beginShutdown prevents additions, so one snapshot is sufficient. Operation
    // failures are returned to their IPC caller; exit only needs settlement.
    await Promise.allSettled([...this.active])
  }
}
