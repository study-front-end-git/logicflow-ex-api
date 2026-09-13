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
