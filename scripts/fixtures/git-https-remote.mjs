import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const REFUSED_USER_MESSAGE = 'This host takes no token under that user name'
export const REFUSED_TOKEN_MESSAGE = 'Invalid user name or token'

export function opensslAvailable() {
  return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0
}

function basic(header) {
  if (typeof header !== 'string' || !/^basic /iu.test(header)) return undefined
  const text = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
  const colon = text.indexOf(':')
  return colon === -1 ? undefined : { user: text.slice(0, colon), password: text.slice(colon + 1) }
}

export function gitHttpsRemote({ accounts = [], refuse = [], names = [], report = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mnemon-git-https-remote-'))
  const projects = join(root, 'repositories')
  mkdirSync(projects)
  const config = join(root, 'gitconfig')
  writeFileSync(config, '')
  const made = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=git-https-remote ' + randomBytes(6).toString('hex'),
    '-addext', 'subjectAltName=' + ['IP:127.0.0.1', ...names.map(name => 'DNS:' + name)].join(','), '-keyout', join(root, 'key.pem'), '-out', join(root, 'certificate.pem'),
  ], { encoding: 'utf8' })
  if (made.status !== 0) {
    rmSync(root, { recursive: true, force: true })
    throw new Error('openssl could not make the certificate: ' + (made.stderr || made.error?.message || 'unknown reason').trim())
  }
  const certificate = join(root, 'certificate.pem')
  const refused = new Set(refuse)

  const server = createServer({ key: readFileSync(join(root, 'key.pem')), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url ?? '/', 'https://127.0.0.1')
    const credential = basic(request.headers.authorization)
    response.once('finish', () => report({
      method: request.method, path: url.pathname + url.search, user: credential?.user, password: credential !== undefined && credential.password !== '', status: response.statusCode,
    }))
    const answer = (status, text, challenge) => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...(challenge ? { 'www-authenticate': 'Basic realm="git-https-remote"' } : {}) })
      response.end(text + '\n')
    }
    if (credential === undefined) { request.resume(); return answer(401, 'Authentication required', true) }
    if (refused.has(credential.user)) { request.resume(); return answer(403, REFUSED_USER_MESSAGE, false) }
    if (!accounts.some(account => (account.user === '*' || account.user === credential.user) && account.token === credential.password)) {
      request.resume()
      return answer(401, REFUSED_TOKEN_MESSAGE, true)
    }
    const header = name => typeof request.headers[name] === 'string' ? request.headers[name] : undefined
    const backend = spawn('git', ['http-backend'], {
      env: {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
        HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config,
        GIT_PROJECT_ROOT: projects, GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method ?? 'GET', PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: header('content-type') ?? '',
        ...(header('content-length') === undefined ? {} : { CONTENT_LENGTH: header('content-length') }),
        ...(header('content-encoding') === undefined ? {} : { HTTP_CONTENT_ENCODING: header('content-encoding') }),
        ...(header('git-protocol') === undefined ? {} : { HTTP_GIT_PROTOCOL: header('git-protocol'), GIT_PROTOCOL: header('git-protocol') }),
        REMOTE_USER: credential.user, REMOTE_ADDR: '127.0.0.1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    request.pipe(backend.stdin)
    let head = Buffer.alloc(0)
    let started = false
    let failure = ''
    backend.stderr.on('data', chunk => { failure += chunk })
    backend.stdout.on('data', chunk => {
      if (started) { response.write(chunk); return }
      head = Buffer.concat([head, chunk])
      const crlf = head.indexOf('\r\n\r\n')
      const lf = head.indexOf('\n\n')
      const end = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf
      if (end === -1) return
      let status = 200
      const headers = {}
      for (const line of head.subarray(0, end).toString('latin1').split(/\r?\n/u)) {
        const colon = line.indexOf(':')
        if (colon === -1) continue
        const name = line.slice(0, colon).trim()
        const value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 500
        else headers[name] = value
      }
      started = true
      response.writeHead(status, headers)
      response.write(head.subarray(end + (end === crlf ? 4 : 2)))
    })
    backend.once('close', code => {
      if (!started) answer(500, 'git http-backend failed (' + String(code) + '): ' + failure.trim(), false)
      else response.end()
    })
  })

  return {
    server,
    certificate,
    async start(port = 0) {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolveListen)
      })
      return server.address().port
    },
    repository(path = 'team/memory.git', host = '127.0.0.1') {
      const made = spawnSync('git', ['init', '--bare', '--quiet', join(projects, path)], {
        env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config }, encoding: 'utf8',
      })
      if (made.status !== 0) throw new Error('git init failed: ' + made.stderr.trim())
      return { directory: join(projects, path), url: 'https://' + host + ':' + String(server.address().port) + '/' + path }
    },
    async close() {
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(resolveClose))
      rmSync(root, { recursive: true, force: true })
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    account: { type: 'string', multiple: true, default: [] },
    refuse: { type: 'string', multiple: true, default: [] },
    name: { type: 'string', multiple: true, default: [] },
    repository: { type: 'string', multiple: true, default: [] },
    port: { type: 'string', default: '0' },
    'port-file': { type: 'string' },
  } })
  const accounts = values.account.map(value => {
    const colon = value.indexOf(':')
    if (colon <= 0 || colon === value.length - 1) throw new Error('--account takes <user>:<token>, with * as the user for any name')
    return { user: value.slice(0, colon), token: value.slice(colon + 1) }
  })
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0 through 65535')
  const remote = gitHttpsRemote({
    accounts, refuse: values.refuse, names: values.name,
    report: event => console.log('Git HTTPS remote: ' + event.method + ' ' + event.path + ' as '
      + (event.user === undefined ? '(no credentials)' : event.user + (event.password ? ' with a password' : ' without a password')) + ' -> ' + String(event.status)),
  })
  const bound = await remote.start(port)
  if (values['port-file'] !== undefined) writeFileSync(values['port-file'], String(bound))
  for (const path of values.repository.length === 0 ? ['team/memory.git'] : values.repository) console.log('Git HTTPS remote: ' + remote.repository(path).url)
  console.log('Git HTTPS remote: certificate ' + remote.certificate + ' (GIT_SSL_CAINFO); takes ' + (accounts.map(account => account.user).join(', ') || 'no account')
    + (values.refuse.length === 0 ? '' : '; refuses ' + values.refuse.join(', ')))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void remote.close() })
}
