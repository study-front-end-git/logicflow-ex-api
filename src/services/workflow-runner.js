const HttpError = require('../utils/http-error')
const { getValueAtPath } = require('../utils/value-path')
const { callChatCompletion } = require('./llm-service')
const { testHttpNode: callHttpNode } = require('./http-node-service')

function getExecutionOrder(nodes, edges) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(nodes.map((node) => [node.id, []]))

  for (const edge of edges) {
    if (!nodeMap.has(edge.sourceNodeId) || !nodeMap.has(edge.targetNodeId)) {
      throw new HttpError(400, `Edge ${edge.id} references a missing node`, 'INVALID_WORKFLOW_GRAPH')
    }
    indegree.set(edge.targetNodeId, indegree.get(edge.targetNodeId) + 1)
    outgoing.get(edge.sourceNodeId).push(edge.targetNodeId)
  }

  const queue = nodes.filter((node) => indegree.get(node.id) === 0)
  const order = []
  while (queue.length) {
    const node = queue.shift()
    order.push(node)
    for (const targetId of outgoing.get(node.id)) {
      indegree.set(targetId, indegree.get(targetId) - 1)
      if (indegree.get(targetId) === 0) queue.push(nodeMap.get(targetId))
    }
  }

  if (order.length !== nodes.length) {
    throw new HttpError(400, 'Workflow contains a cycle', 'WORKFLOW_CYCLE')
  }
  return order
}

function resolveReference(value, results, nodeId) {
  const reference = value.referenceValue || value.referenceKey
  if (!Array.isArray(reference) || reference.length < 2) {
    throw new HttpError(400, `Node ${nodeId} has an invalid variable reference`, 'INVALID_VARIABLE_REFERENCE')
  }

  const resolved = getValueAtPath(results.get(reference[0]), reference.slice(1))
  if (!resolved.found) {
    throw new HttpError(400, `Cannot resolve ${reference.join('.')}`, 'VARIABLE_NOT_FOUND')
  }
  return resolved.value
}

function resolveParameters(parameters, inputs, results, nodeId) {
  return (Array.isArray(parameters) ? parameters : []).reduce((output, parameter) => {
    if (!parameter.name) return output
    if (parameter.valueType === 'reference') {
      output[parameter.name] = resolveReference(parameter, results, nodeId)
    } else if (Object.prototype.hasOwnProperty.call(inputs, parameter.name)) {
      output[parameter.name] = inputs[parameter.name]
    } else if (parameter.inputValue !== undefined && parameter.inputValue !== '') {
      output[parameter.name] = parameter.inputValue
    } else if (parameter.defaultValue !== undefined && parameter.defaultValue !== '') {
      output[parameter.name] = parameter.defaultValue
    } else if (parameter.required !== false) {
      throw new HttpError(400, `Missing required input: ${parameter.name}`, 'MISSING_WORKFLOW_INPUT')
    }
    return output
  }, {})
}

function stringifyValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function interpolatePrompt(template, nodes, results, localValues) {
  let prompt = String(template || '')
  for (const [name, value] of Object.entries(localValues)) {
    prompt = prompt.replaceAll(`{{${name}}}`, stringifyValue(value))
  }
  for (const node of nodes) {
    const output = results.get(node.id) || {}
    const aliases = [node.id, node.type, node.properties?.title, node.properties?.label].filter(Boolean)
    for (const [name, value] of Object.entries(output)) {
      for (const alias of aliases) {
        prompt = prompt.replaceAll(`/${alias}.${name}`, stringifyValue(value))
      }
    }
  }
  return prompt
}

// function appendUnusedInputsToPrompt(userPrompt, systemPromptTemplate, userPromptTemplate, localValues) {
//   const unusedInputs = Object.fromEntries(Object.entries(localValues).filter(([name]) => {
//     const token = `{{${name}}}`
//     return !String(systemPromptTemplate || '').includes(token) && !String(userPromptTemplate || '').includes(token)
//   }))
//   if (!Object.keys(unusedInputs).length) return userPrompt

//   const inputContext = `以下是本次任务的输入变量：\n${JSON.stringify(unusedInputs, null, 2)}`
//   return userPrompt.trim() ? `${userPrompt}\n\n${inputContext}` : inputContext
// }

function parseJsonModelOutput(content, node, outputNames) {
  const normalized = String(content || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

  let parsed
  try {
    parsed = JSON.parse(normalized)
  } catch (error) {
    throw new HttpError(
      502,
      `Model node ${node.id} did not return valid JSON`,
      'INVALID_MODEL_JSON',
    )
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(
      502,
      `Model node ${node.id} must return a JSON object`,
      'INVALID_MODEL_JSON',
    )
  }

  const missingNames = outputNames.filter((name) => !Object.prototype.hasOwnProperty.call(parsed, name))
  if (missingNames.length) {
    throw new HttpError(
      502,
      `Model JSON is missing output fields: ${missingNames.join(', ')}`,
      'MODEL_OUTPUT_FIELD_MISSING',
    )
  }

  return parsed
}

async function executeModelNode(node, nodes, inputs, results, invokeModel) {
  const properties = node.properties || {}
  const config = properties.config || {}
  const outputFormat = config.outputFormat === 'json' ? 'json' : 'text'
  const outputNames = (Array.isArray(properties.output) ? properties.output : [])
    .map((item) => item.name)
    .filter(Boolean)
  const localValues = resolveParameters(properties.data, inputs, results, node.id)
  let systemPrompt = interpolatePrompt(config.systemPrompt, nodes, results, localValues)
  let userPrompt = interpolatePrompt(config.userPrompt, nodes, results, localValues)
  if(!userPrompt.trim()) userPrompt = JSON.stringify(localValues)
  // userPrompt = appendUnusedInputsToPrompt(
  //   userPrompt,
  //   config.systemPrompt,
  //   config.userPrompt,
  //   localValues,
  // )

  if (outputFormat === 'json') {
    if (!outputNames.length) {
      throw new HttpError(
        400,
        `Model node ${node.id} has no JSON output fields configured`,
        'MODEL_OUTPUT_NOT_CONFIGURED',
      )
    }
    const jsonInstruction = [
      '只返回一个合法的 JSON 对象，不要返回 Markdown 代码块或其他解释文字。',
      `JSON 必须包含这些字段：${outputNames.join(', ')}。`,
      `返回格式示例：${JSON.stringify(Object.fromEntries(outputNames.map((name) => [name, ''])))}。`,
    ].join('\n')
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${jsonInstruction}` : jsonInstruction
  }

  const response = await invokeModel({
    model: config.modelId,
    systemPrompt,
    userPrompt,
    temperature: Number.isFinite(config.temperature) ? config.temperature : 0.7,
    maxTokens: Number.isInteger(config.maxTokens) ? config.maxTokens : 2048,
  })
  const outputName = outputNames[0] || 'text'
  const output = outputFormat === 'json'
    ? parseJsonModelOutput(response.content, node, outputNames)
    : { [outputName]: response.content, text: response.content }

  return {
    output,
    usage: response.usage,
    model: response.model,
  }
}

async function executeHttpNode(node, results, invokeHttpNode) {
  const properties = node.properties || {}
  const variables = Object.fromEntries(results.entries())
  const outputDefinitions = (Array.isArray(properties.output) ? properties.output : [])
    .filter((item) => typeof item?.name === 'string' && item.name.trim())
  const result = await invokeHttpNode({
    config: properties.config || {},
    output: outputDefinitions,
    variables,
  })
  const responseBody = result.response?.body
  let output = result.output || {}

  if (!outputDefinitions.length) {
    if (Array.isArray(responseBody)) {
      const fieldNames = [...new Set(responseBody.flatMap((item) => (
        item !== null && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : []
      )))]
      output = fieldNames.length
        ? Object.fromEntries(fieldNames.map((fieldName) => [
          fieldName,
          responseBody.map((item) => item?.[fieldName]),
        ]))
        : { items: responseBody }
    } else if (responseBody !== null && typeof responseBody === 'object') {
      output = responseBody
    } else {
      output = { body: responseBody }
    }
  }

  return {
    output,
    metadata: {
      http: {
        method: result.request?.method,
        url: result.request?.url,
        status: result.response?.status,
        durationMs: result.response?.durationMs,
      },
    },
  }
}

async function runWorkflow(
  graphData,
  inputs = {},
  invokeModel = callChatCompletion,
  invokeHttpNode = callHttpNode,
) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new HttpError(400, 'inputs must be an object', 'INVALID_WORKFLOW_INPUTS')
  }
  const nodes = graphData?.nodes || []
  const edges = graphData?.edges || []
  if (!nodes.length) throw new HttpError(400, 'Workflow has no nodes', 'EMPTY_WORKFLOW')
  if (!nodes.some((node) => node.type === 'start-node')) {
    throw new HttpError(400, 'Workflow has no start node', 'START_NODE_NOT_FOUND')
  }
  if (!nodes.some((node) => node.type === 'end-node')) {
    throw new HttpError(400, 'Workflow has no end node', 'END_NODE_NOT_FOUND')
  }

  const results = new Map()
  const trace = []
  for (const node of getExecutionOrder(nodes, edges)) {
    const startedAt = Date.now()
    let output
    let metadata = {}
    const properties = node.properties || {}

    if (node.type === 'start-node' || node.type === 'input-node') {
      output = resolveParameters(properties.data, inputs, results, node.id)
    } else if (node.type === 'http-node') {
      const httpResult = await executeHttpNode(node, results, invokeHttpNode)
      output = httpResult.output
      metadata = httpResult.metadata
    } else if (node.type === 'model-node') {
      const modelResult = await executeModelNode(node, nodes, inputs, results, invokeModel)
      output = modelResult.output
      metadata = { model: modelResult.model, usage: modelResult.usage }
    } else if (node.type === 'end-node') {
      output = properties.outputMode === 'text' || properties.isCustomReply
        ? interpolatePrompt(properties.cueWord, nodes, results, {})
        : resolveParameters(properties.data, inputs, results, node.id)
    } else {
      throw new HttpError(400, `Unsupported node type: ${node.type}`, 'UNSUPPORTED_NODE_TYPE')
    }

    results.set(node.id, output)
    trace.push({
      nodeId: node.id,
      nodeType: node.type,
      title: properties.title || properties.label || node.type,
      durationMs: Date.now() - startedAt,
      ...metadata,
    })
  }

  const endNodes = nodes.filter((node) => node.type === 'end-node')
  const output = results.get(endNodes[endNodes.length - 1].id)
  return { output, trace }
}

module.exports = { getExecutionOrder, runWorkflow }
