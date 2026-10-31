import type { MonitorTarget } from '../../types/config'
import { workerConfig } from '../../uptime.config'
import { getStoredMonitors, type RuntimeEnv } from '../../util/runtimeConfig'
import { SchedulerError } from '../../util/schedulerClient'
import { RunCoordinator } from './coordinator'
import { CompactedMonitorStateWrapper, compareAndSetStore, getFromStore } from './store'

const CHECK_INTERVAL_MS = 10 * 60 * 1000

export class SchedulerState {
  private coordinator = new RunCoordinator()

  constructor(
    private storage: DurableObjectStorage,
    private env: RuntimeEnv,
    private check: (monitors: MonitorTarget[]) => Promise<void>
  ) {}

  async ensureAlarm(): Promise<{ nextAlarm: number }> {
    const existing = await this.storage.getAlarm()
    if (existing !== null && existing > Date.now()) return { nextAlarm: existing }
    const nextAlarm = Date.now() + 1000
    await this.storage.setAlarm(nextAlarm)
    return { nextAlarm }
  }

  runNow(): Promise<void> {
    return this.coordinator.run(async () => {
      // Arm before external I/O so an interrupted manual run can recover.
      await this.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS)
      try {
        const monitors = await this.readMonitors()
        await this.finishDeletes()
        await this.check(monitors)
      } finally {
        await this.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS)
      }
    })
  }

  listMonitors(): Promise<MonitorTarget[]> {
    return this.coordinator.mutate(() => this.readMonitors())
  }

  private async readMonitors(): Promise<MonitorTarget[]> {
    const stored = await this.storage.get<MonitorTarget[]>('monitors')
    if (stored !== undefined) return stored
    // Migrate the existing KV/D1 configuration once; subsequent reads use the DO.
    const monitors = await getStoredMonitors({ ...this.env, MONITOR_SCHEDULER_DO: undefined })
    await this.storage.put('monitors', monitors)
    return monitors
  }

  addMonitor(monitor: MonitorTarget): Promise<MonitorTarget[]> {
    return this.coordinator.mutate(async () => {
      const monitors = await this.readMonitors()
      if ([...workerConfig.monitors, ...monitors].some((item) => item.id === monitor.id)) {
        throw new SchedulerError('监测 ID 已存在，请换一个名称或 ID', 409)
      }
      await this.finishDeletes()
      const next = [...monitors, monitor]
      await this.storage.put('monitors', next)
      return next
    })
  }

  deleteMonitor(id: string): Promise<MonitorTarget[]> {
    return this.coordinator.mutate(async () => {
      const monitors = await this.readMonitors()
      const pending = (await this.storage.get<string[]>('pendingDeletes')) ?? []
      if (!monitors.some((item) => item.id === id) && !pending.includes(id)) {
        throw new SchedulerError('只能删除在页面中添加的监测项', 404)
      }
      // A failed read must not modify configuration or reset monitoring history.
      await getFromStore(this.env, 'state')
      const next = monitors.filter((item) => item.id !== id)
      await this.storage.transaction(async (txn) => {
        await txn.put('monitors', next)
        await txn.put('pendingDeletes', Array.from(new Set([...pending, id])))
      })
      await this.finishDeletes()
      return next
    })
  }

  private async finishDeletes(): Promise<void> {
    const pending = (await this.storage.get<string[]>('pendingDeletes')) ?? []
    if (!pending.length) return
    const raw = await getFromStore(this.env, 'state')
    if (raw !== null) {
      const state = new CompactedMonitorStateWrapper(raw)
      for (const id of pending) {
        delete state.data.incident[id]
        delete state.data.latency[id]
      }
      state.data.overallUp = 0
      state.data.overallDown = 0
      for (const incident of Object.values(state.data.incident)) {
        if (!incident.end.length) continue
        if (incident.end[incident.end.length - 1] === null) state.data.overallDown++
        else state.data.overallUp++
      }
      await compareAndSetStore(this.env, 'state', raw, state.getCompactedStateStr())
    }
    // The journal survives a restart between the DO commit and D1 cleanup.
    await this.storage.delete('pendingDeletes')
  }
}
