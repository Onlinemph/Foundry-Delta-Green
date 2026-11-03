// AGENCY: zip dist/ into release/gurps-agency-<version>.zip for manual install
// (unzip into <Foundry data>/Data/systems/gurps, replacing the official system).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const { version } = JSON.parse(readFileSync('system.json', 'utf8'))
if (!existsSync('dist/system.json')) throw new Error('dist/ is missing; run npm run build first')
mkdirSync('release', { recursive: true })
const out = resolve(`release/gurps-agency-${version}.zip`)
rmSync(out, { force: true })
execFileSync('zip', ['-qr', out, '.'], { cwd: 'dist', stdio: 'inherit' })
console.log(`Wrote ${out}`)
