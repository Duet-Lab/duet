// Launch the actual macOS release outside the checkout, where hoisted dependencies cannot hide packaging errors.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('@playwright/test')

async function checkDmg(dmg) {
  const dir = mkdtempSync(join(tmpdir(), 'duet-release-'))
  const mount = join(dir, 'volume')
  const home = join(dir, 'home')
  mkdirSync(home)
  mkdirSync(mount)
  let mounted = false
  try {
    execFileSync('hdiutil', [
      'attach',
      dmg,
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mount
    ])
    mounted = true
    const env = { ...process.env, HOME: home, DUET_CONFIG_FILE: join(home, 'pointer.json') }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_PATH
    const app = await electron.launch({
      executablePath: join(mount, 'Duet.app', 'Contents', 'MacOS', 'Duet'),
      args: ['--remote-debugging-port=0', `--user-data-dir=${join(home, 'chromium')}`],
      cwd: home,
      env,
      timeout: 20000
    })
    try {
      const window = await app.firstWindow({ timeout: 20000 })
      await window.waitForLoadState('domcontentloaded')
      assert.equal(
        await window.evaluate(() => typeof window.api?.getAppState),
        'function',
        'The packaged preload did not expose window.api.getAppState'
      )
      assert.equal(
        await window.evaluate(async () => (await window.api.getAppState()).status),
        'no_config'
      )
      await window.getByText('DuetData', { exact: false }).first().waitFor({ timeout: 10000 })
      console.log('Packaged Duet: setup window rendered and renderer-to-main IPC works.')
    } finally {
      await app.close()
    }
  } finally {
    if (mounted) execFileSync('hdiutil', ['detach', mount])
    rmSync(dir, { recursive: true, force: true })
  }
}

checkDmg(resolve(process.argv[2])).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
