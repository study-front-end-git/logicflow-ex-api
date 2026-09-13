const assert = require('node:assert/strict')
const { test } = require('node:test')

const { validateGraphData } = require('../src/validators/workflow')

test('validateGraphData accepts a valid LogicFlow graph', () => {
  const graph = {
    nodes: [
      { id: 'start', type: 'start-node', properties: {} },
      { id: 'end', type: 'end-node', properties: {} },
    ],
    edges: [
      { id: 'edge-1', sourceNodeId: 'start', targetNodeId: 'end' },
    ],
  }

  assert.equal(validateGraphData(graph), graph)
})

test('validateGraphData rejects edges that reference missing nodes', () => {
  assert.throws(
    () => validateGraphData({
      nodes: [{ id: 'start', type: 'start-node' }],
      edges: [{ id: 'edge-1', sourceNodeId: 'start', targetNodeId: 'missing' }],
    }),
    (error) => error.status === 400 && error.code === 'INVALID_EDGE_REFERENCE',
  )
})
