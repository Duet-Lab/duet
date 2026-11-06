import { beforeEach, describe, expect, it, vi } from 'vitest'

const tray = vi.hoisted(() => ({
  setImage: vi.fn(),
  setToolTip: vi.fn(),
  setContextMenu: vi.fn(),
  on: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getLoginItemSettings: () => ({ openAtLogin: false }) },
  Tray: vi.fn(function () {
    return tray
  }),
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: { createFromPath: vi.fn(() => ({ setTemplateImage: vi.fn() })) }
}))

const { createTray, updateTrayIcon } = await import('../../../src/platform/tray')

describe('tray icon updates (Idle contract)', () => {
  // Each test starts from a freshly created tray in the ready state, so tests do not depend
  // on the order they run in or on the module state another test left behind.
  beforeEach(() => {
    createTray('ready', { onShowWindow: vi.fn(), onQuit: vi.fn() })
    vi.clearAllMocks()
  })

  it('skips an update identical to what the tray already shows', () => {
    updateTrayIcon('ready', null)
    expect(tray.setImage).not.toHaveBeenCalled()

    updateTrayIcon('ready', 'warning')
    updateTrayIcon('ready', 'warning')
    expect(tray.setImage).toHaveBeenCalledOnce()
    expect(tray.setToolTip).toHaveBeenCalledOnce()

    updateTrayIcon('ready', 'error')
    updateTrayIcon('ready', null)
    expect(tray.setImage).toHaveBeenCalledTimes(3)
  })

  it('treats a different status with the same icon as a change of tooltip', () => {
    updateTrayIcon('ready', 'warning')
    vi.clearAllMocks()
    updateTrayIcon('path_lost', null)
    expect(tray.setImage).toHaveBeenCalledOnce()
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Duet — папка не найдена')
  })
})
