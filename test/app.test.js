const assert = require('node:assert/strict')
const { after, before, test } = require('node:test')

const app = require('../src/app')

let baseUrl
let server

before(async () => {
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

test('GET /api/health returns the service status', async () => {
  const response = await fetch(`${baseUrl}/api/health`)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.code, 0)
  assert.equal(body.data.status, 'ok')
})

test('CORS allows the configured frontend origin', async () => {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: 'http://localhost:8080' },
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8080')
})

test('CORS handles preflight requests', async () => {
  const response = await fetch(`${baseUrl}/api/workflows`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:8080',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  })

  assert.equal(response.status, 204)
  assert.match(response.headers.get('access-control-allow-methods'), /POST/)
  assert.match(response.headers.get('access-control-allow-headers'), /Content-Type/i)
})

test('unknown routes return a JSON 404 response', async () => {
  const response = await fetch(`${baseUrl}/missing`)
  const body = await response.json()

  assert.equal(response.status, 404)
  assert.equal(body.code, 404)
})

test('PUT /api/workflows/:id rejects invalid graph data before accessing MySQL', async () => {
  const response = await fetch(`${baseUrl}/api/workflows/workflow-1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graphData: { nodes: [], edges: 'invalid' } }),
  })
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.code, 'INVALID_GRAPH_DATA')
})

test('PUT /api/workflows/:id requires createVersion to be a boolean', async () => {
  const response = await fetch(`${baseUrl}/api/workflows/workflow-1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      graphData: { nodes: [], edges: [] },
      createVersion: 'true',
    }),
  })
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.code, 'INVALID_CREATE_VERSION')
})

test('POST /api/workflows requires a workflow name', async () => {
  const response = await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'missing name' }),
  })
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.code, 'WORKFLOW_NAME_REQUIRED')
})
