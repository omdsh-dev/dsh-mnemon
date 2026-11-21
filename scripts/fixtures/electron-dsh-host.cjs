const { app } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

if (!process.env.DSH_HOME) throw new Error('An isolated DSH_HOME is required')
app.setPath('userData', join(process.env.DSH_HOME, 'electron'))
app.on('window-all-closed', () => {})
process.execArgv.push('--expose-internals')
process.argv = [process.execPath, ...process.argv.slice(process.argv.indexOf(__filename) + 1)]
app.whenReady().then(async () => {
  app.dock?.hide()
  console.log('Electron fixture Host: ' + JSON.stringify({
    electron: process.versions.electron, node: process.versions.node,
    type: process.type, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  }))
  const cli = await import(pathToFileURL(process.argv[1]).href)
  await cli.runCli()
}).catch(error => { console.error(error); app.exit(1) })
