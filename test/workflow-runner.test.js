const assert = require('node:assert/strict')
const { test } = require('node:test')

const { getExecutionOrder, runWorkflow } = require('../src/services/workflow-runner')

const graph = {
  nodes: [
    {
      id: 'start',
      type: 'start-node',
      properties: { data: [{ name: 'question', required: true }] },
    },
    {
      id: 'model',
      type: 'model-node',
      properties: {
        data: [{ name: 'question', valueType: 'reference', referenceValue: ['start', 'question'] }],
        config: {
          modelId: 'test-model',
          systemPrompt: 'Answer briefly',
          userPrompt: '{{question}}',
          temperature: 0.7,
          maxTokens: 100,
        },
        output: [{ name: 'text' }],
      },
    },
    {
      id: 'end',
      type: 'end-node',
      properties: {
        outputMode: 'variable',
        data: [{ name: 'answer', valueType: 'reference', referenceValue: ['model', 'text'] }],
      },
    },
  ],
  edges: [
    { id: 'e1', sourceNodeId: 'start', targetNodeId: 'model' },
    { id: 'e2', sourceNodeId: 'model', targetNodeId: 'end' },
  ],
}

test('getExecutionOrder sorts workflow nodes by their edges', () => {
  assert.deepEqual(
    getExecutionOrder(graph.nodes, graph.edges).map((node) => node.id),
    ['start', 'model', 'end'],
  )
})

test('runWorkflow resolves variables and returns the end-node output', async () => {
  let receivedRequest
  const result = await runWorkflow(graph, { question: 'hello' }, async (request) => {
    receivedRequest = request
    return {
      content: 'world',
      model: 'test-model',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }
  })

  assert.equal(receivedRequest.userPrompt, 'hello')
  assert.deepEqual(result.output, { answer: 'world' })
  assert.equal(result.trace.length, 3)
})

test('runWorkflow rejects cyclic workflows', async () => {
  const cyclicGraph = {
    ...graph,
    edges: [
      ...graph.edges,
      { id: 'e3', sourceNodeId: 'end', targetNodeId: 'start' },
    ],
  }

  await assert.rejects(
    runWorkflow(cyclicGraph, { question: 'hello' }),
    (error) => error.code === 'WORKFLOW_CYCLE',
  )
})

test('runWorkflow parses JSON model output using configured output names', async () => {
  const jsonGraph = JSON.parse(JSON.stringify(graph))
  const modelNode = jsonGraph.nodes.find((node) => node.id === 'model')
  const endNode = jsonGraph.nodes.find((node) => node.id === 'end')
  modelNode.properties.config.outputFormat = 'json'
  modelNode.properties.output = [{ name: 'output1' }]
  endNode.properties.data = [
    { name: 'output1', valueType: 'reference', referenceValue: ['model', 'output1'] },
  ]

  let receivedRequest
  const result = await runWorkflow(jsonGraph, { question: 'hello' }, async (request) => {
    receivedRequest = request
    return {
      content: '```json\n{"output1":"structured answer"}\n```',
      model: 'test-model',
      usage: {},
    }
  })

  assert.match(receivedRequest.systemPrompt, /output1/)
  assert.deepEqual(result.output, { output1: 'structured answer' })
})

test('runWorkflow returns a string when the end node uses text mode', async () => {
  const textGraph = JSON.parse(JSON.stringify(graph))
  const endNode = textGraph.nodes.find((node) => node.id === 'end')
  endNode.properties.outputMode = 'text'
  endNode.properties.cueWord = 'plain text result'

  const result = await runWorkflow(textGraph, { question: 'hello' }, async () => ({
    content: 'world',
    model: 'test-model',
    usage: {},
  }))

  assert.equal(result.output, 'plain text result')
})

test('runWorkflow executes an HTTP node and exposes its output to a model node', async () => {
  const httpGraph = {
    nodes: [
      {
        id: 'start',
        type: 'start-node',
        properties: { data: [{ name: 'userId', required: true }] },
      },
      {
        id: 'http',
        type: 'http-node',
        properties: {
          config: {
            method: 'GET',
            url: 'https://example.com/users/{userId}',
            pathParams: [{ key: 'userId', valueType: 'reference', referenceValue: ['start', 'userId'] }],
          },
          output: [{ name: '', value: 'items', label: 'items', children: [{ value: 'name', label: 'name' }] }],
        },
      },
      {
        id: 'model',
        type: 'model-node',
        properties: {
          data: [{ name: 'username', valueType: 'reference', referenceValue: ['http', 'items', 'name'] }],
          config: { modelId: 'test-model', userPrompt: '{{username}}' },
          output: [{ name: 'text' }],
        },
      },
      {
        id: 'end',
        type: 'end-node',
        properties: {
          outputMode: 'variable',
          data: [{ name: 'answer', valueType: 'reference', referenceValue: ['model', 'text'] }],
        },
      },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'start', targetNodeId: 'http' },
      { id: 'e2', sourceNodeId: 'http', targetNodeId: 'model' },
      { id: 'e3', sourceNodeId: 'model', targetNodeId: 'end' },
    ],
  }

  let receivedHttpRequest
  let receivedModelRequest
  const result = await runWorkflow(
    httpGraph,
    { userId: '42' },
    async (request) => {
      receivedModelRequest = request
      return { content: 'model answer', model: 'test-model', usage: {} }
    },
    async (request) => {
      receivedHttpRequest = request
      return {
        request: { method: 'GET', url: 'https://example.com/users/42' },
        response: {
          status: 200,
          durationMs: 12,
          body: { items: [{ name: 'Alice' }, { name: 'Bob' }] },
        },
        output: {},
      }
    },
  )

  assert.deepEqual(receivedHttpRequest.variables, { start: { userId: '42' } })
  assert.deepEqual(receivedHttpRequest.output, [])
  assert.equal(receivedModelRequest.userPrompt,'["Alice","Bob"]')
  // assert.match(receivedModelRequest.userPrompt, /^Translate every news item/)
  // assert.match(receivedModelRequest.userPrompt, /"username": \[/)
  // assert.match(receivedModelRequest.userPrompt, /"Alice"/)
  // assert.match(receivedModelRequest.userPrompt, /"Bob"/)
  assert.deepEqual(result.output, { answer: 'model answer' })
  assert.deepEqual(result.trace[1].http, {
    method: 'GET',
    url: 'https://example.com/users/42',
    status: 200,
    durationMs: 12,
  })
})
