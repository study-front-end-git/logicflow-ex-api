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

function createIfElseGraph(logic = 'and', conditions = []) {
  return {
    nodes: [
      {
        id: 'start',
        type: 'start-node',
        properties: { data: [{ name: 'score', required: true }] },
      },
      {
        id: 'branch',
        type: 'if-else-node',
        properties: { title: 'Score branch', config: { logic, conditions } },
      },
      {
        id: 'if-end',
        type: 'end-node',
        properties: { outputMode: 'text', cueWord: 'passed' },
      },
      {
        id: 'else-end',
        type: 'end-node',
        properties: { outputMode: 'text', cueWord: 'failed' },
      },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'start', targetNodeId: 'branch' },
      {
        id: 'e2',
        sourceNodeId: 'branch',
        targetNodeId: 'if-end',
        sourceAnchorId: 'branch_1',
      },
      {
        id: 'e3',
        sourceNodeId: 'branch',
        targetNodeId: 'else-end',
        sourceAnchorId: 'branch_2',
      },
    ],
  }
}

const scoreCondition = {
  enabled: true,
  left: { valueType: 'reference', referenceValue: ['start', 'score'] },
  operator: 'greaterThanOrEqual',
  right: { valueType: 'input', type: 'Number', inputValue: '60' },
}

test('runWorkflow executes only the IF branch when conditions match', async () => {
  const result = await runWorkflow(createIfElseGraph('and', [scoreCondition]), { score: 80 })

  assert.equal(result.output, 'passed')
  assert.equal(result.trace.find((item) => item.nodeId === 'branch').condition.branch, 'if')
  assert.equal(result.trace.find((item) => item.nodeId === 'else-end').status, 'skipped')
})

test('runWorkflow executes only the ELSE branch when conditions do not match', async () => {
  const result = await runWorkflow(createIfElseGraph('and', [scoreCondition]), { score: 40 })

  assert.equal(result.output, 'failed')
  assert.equal(result.trace.find((item) => item.nodeId === 'branch').condition.branch, 'else')
  assert.equal(result.trace.find((item) => item.nodeId === 'if-end').status, 'skipped')
})

test('runWorkflow supports OR conditions and contains', async () => {
  const conditions = [
    scoreCondition,
    {
      enabled: true,
      left: { valueType: 'input', type: 'String', inputValue: 'logicflow' },
      operator: 'contains',
      right: { valueType: 'input', type: 'String', inputValue: 'flow' },
    },
  ]
  const result = await runWorkflow(createIfElseGraph('or', conditions), { score: 40 })

  assert.equal(result.output, 'passed')
  assert.deepEqual(
    result.trace.find((item) => item.nodeId === 'branch').condition.conditionResults,
    [false, true],
  )
})

test('end node returns an empty string when it references a skipped branch node', async () => {
  const branchGraph = {
    nodes: [
      {
        id: 'start',
        type: 'start-node',
        properties: { data: [{ name: 'total', required: true }] },
      },
      {
        id: 'branch',
        type: 'if-else-node',
        properties: {
          config: {
            logic: 'and',
            conditions: [{
              enabled: true,
              left: { valueType: 'reference', referenceValue: ['start', 'total'] },
              operator: 'greaterThan',
              right: { valueType: 'input', type: 'Number', inputValue: '0' },
            }],
          },
        },
      },
      {
        id: 'model',
        type: 'model-node',
        properties: {
          data: [],
          config: { modelId: 'test-model', userPrompt: 'translate' },
          output: [{ name: 'text' }],
        },
      },
      {
        id: 'end',
        type: 'end-node',
        properties: {
          outputMode: 'variable',
          data: [{ name: 'text', valueType: 'reference', referenceValue: ['model', 'text'] }],
        },
      },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'start', targetNodeId: 'branch' },
      { id: 'e2', sourceNodeId: 'branch', targetNodeId: 'model', sourceAnchorId: 'branch_1' },
      { id: 'e3', sourceNodeId: 'branch', targetNodeId: 'end', sourceAnchorId: 'branch_2' },
      { id: 'e4', sourceNodeId: 'model', targetNodeId: 'end' },
    ],
  }

  let modelWasCalled = false
  const result = await runWorkflow(branchGraph, { total: 0 }, async () => {
    modelWasCalled = true
    return { content: 'unexpected', model: 'test-model', usage: {} }
  })

  assert.equal(modelWasCalled, false)
  assert.deepEqual(result.output, { text: '' })
  assert.equal(result.trace.find((item) => item.nodeId === 'branch').condition.branch, 'else')
  assert.equal(result.trace.find((item) => item.nodeId === 'model').status, 'skipped')
})

test('end node still rejects a missing variable from an executed node', async () => {
  const invalidGraph = JSON.parse(JSON.stringify(graph))
  const endNode = invalidGraph.nodes.find((node) => node.id === 'end')
  endNode.properties.data[0].referenceValue = ['model', 'missing']

  await assert.rejects(
    runWorkflow(invalidGraph, { question: 'hello' }, async () => ({
      content: 'world',
      model: 'test-model',
      usage: {},
    })),
    (error) => error.code === 'VARIABLE_NOT_FOUND',
  )
})

test('runWorkflow keeps end-node output authoritative when an output node also runs', async () => {
  const outputBranchGraph = {
    nodes: [
      {
        id: 'start',
        type: 'start-node',
        properties: { data: [{ name: 'total', required: true }] },
      },
      {
        id: 'branch',
        type: 'if-else-node',
        properties: {
          config: {
            logic: 'and',
            conditions: [{
              enabled: true,
              left: { valueType: 'reference', referenceValue: ['start', 'total'] },
              operator: 'greaterThan',
              right: { valueType: 'input', type: 'Number', inputValue: '0' },
            }],
          },
        },
      },
      {
        id: 'model',
        type: 'model-node',
        properties: {
          data: [],
          config: { modelId: 'test-model', userPrompt: 'translate' },
          output: [{ name: 'text' }],
        },
      },
      {
        id: 'fallback',
        type: 'output-node',
        properties: {
          data: [{ name: 'output', valueType: 'input', inputValue: 'no response' }],
          cueWord: '',
        },
      },
      {
        id: 'end',
        type: 'end-node',
        properties: {
          outputMode: 'variable',
          data: [{ name: 'text', valueType: 'reference', referenceValue: ['model', 'text'] }],
        },
      },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'start', targetNodeId: 'branch' },
      { id: 'e2', sourceNodeId: 'branch', targetNodeId: 'model', sourceAnchorId: 'branch_1' },
      { id: 'e3', sourceNodeId: 'branch', targetNodeId: 'fallback', sourceAnchorId: 'branch_2' },
      { id: 'e4', sourceNodeId: 'model', targetNodeId: 'end' },
      { id: 'e5', sourceNodeId: 'fallback', targetNodeId: 'end' },
    ],
  }

  let modelWasCalled = false
  const result = await runWorkflow(outputBranchGraph, { total: 0 }, async () => {
    modelWasCalled = true
    return { content: 'unexpected', model: 'test-model', usage: {} }
  })

  assert.equal(modelWasCalled, false)
  assert.deepEqual(result.output, { text: '' })
  assert.deepEqual(result.trace.find((item) => item.nodeId === 'fallback').output, {
    output: 'no response',
  })
  assert.equal(result.trace.find((item) => item.nodeId === 'fallback').answer, '')
})

test('end node returns its configured model reference after an output node executes', async () => {
  const graphWithOutputNode = JSON.parse(JSON.stringify(graph))
  const endNode = graphWithOutputNode.nodes.find((node) => node.id === 'end')
  graphWithOutputNode.nodes.splice(graphWithOutputNode.nodes.length - 1, 0, {
    id: 'output',
    type: 'output-node',
    properties: {
      data: [{ name: 'fallback', valueType: 'input', inputValue: 'do not return this' }],
      cueWord: '',
    },
  })
  graphWithOutputNode.edges = [
    { id: 'e1', sourceNodeId: 'start', targetNodeId: 'model' },
    { id: 'e2', sourceNodeId: 'model', targetNodeId: 'output' },
    { id: 'e3', sourceNodeId: 'output', targetNodeId: endNode.id },
  ]

  const result = await runWorkflow(graphWithOutputNode, { question: 'hello' }, async () => ({
    content: 'model result',
    model: 'test-model',
    usage: {},
  }))

  assert.deepEqual(result.output, { answer: 'model result' })
  assert.deepEqual(result.trace.find((item) => item.nodeId === 'output').output, {
    fallback: 'do not return this',
  })
})

test('runWorkflow renders output-node text and supports it as a terminal node', async () => {
  const outputOnlyGraph = {
    nodes: [
      {
        id: 'start',
        type: 'start-node',
        properties: { data: [{ name: 'name', required: true }] },
      },
      {
        id: 'output',
        type: 'output-node',
        properties: {
          data: [{ name: 'name', valueType: 'reference', referenceValue: ['start', 'name'] }],
          cueWord: 'hello {{name}}',
        },
      },
    ],
    edges: [{ id: 'e1', sourceNodeId: 'start', targetNodeId: 'output' }],
  }

  const result = await runWorkflow(outputOnlyGraph, { name: 'LogicFlow' })

  assert.equal(result.output, 'hello LogicFlow')
  assert.equal(result.trace.at(-1).nodeType, 'output-node')
  assert.deepEqual(result.trace.at(-1).output, { name: 'LogicFlow' })
  assert.equal(result.trace.at(-1).answer, 'hello LogicFlow')
})
