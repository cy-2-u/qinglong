export class RunCoordinator {
  private pending: Promise<void> | null = null
  private tail: Promise<void> = Promise.resolve()

  run(run: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending
    const task = this.tail.then(run)
    this.pending = task
    task
      .finally(() => {
        if (this.pending === task) this.pending = null
      })
      .catch(() => undefined)
    this.tail = task.catch(() => undefined)
    return task
  }

  mutate<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task)
    this.tail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
}
