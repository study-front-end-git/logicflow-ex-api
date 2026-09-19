const { isDeepStrictEqual } = require('node:util')

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

function resolveReference(value, results, nodeId, options = {}) {
  const reference = value.referenceValue || value.referenceKey
  if (!Array.isArray(reference) || reference.length < 2) {
    throw new HttpError(400, `Node ${nodeId} has an invalid variable reference`, 'INVALID_VARIABLE_REFERENCE')
  }

  if (
    options.allowSkippedReferences &&
    options.executionStates?.get(reference[0]) === 'skipped'
  ) {
    return ''
  }

  const resolved = getValueAtPath(results.get(reference[0]), reference.slice(1))
  if (!resolved.found) {
    throw new HttpError(400, `Cannot resolve ${reference.join('.')}`, 'VARIABLE_NOT_FOUND')
  }
  return resolved.value
}

function resolveParameters(parameters, inputs, results, nodeId, options = {}) {
  return (Array.isArray(parameters) ? parameters : []).reduce((output, parameter) => {
    if (!parameter.name) return output
    if (parameter.valueType === 'reference') {
      output[parameter.name] = resolveReference(parameter, results, nodeId, options)
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

function parseConditionInput(operand, nodeId) {
  const value = operand?.inputValue
  const type = operand?.type || 'String'

  if (type === 'String') return value == null ? '' : String(value)
  if (type === 'Number') {
    const numberValue = Number(value)
    if (value === '' || value === null || value === undefined || Number.isNaN(numberValue)) {
      throw new HttpError(400, `IF/ELSE node ${nodeId} contains an invalid Number operand`, 'INVALID_IF_ELSE_OPERAND')
    }
    return numberValue
  }
  if (type === 'Boolean') {
    if (value === true || String(value).toLowerCase() === 'true') return true
    if (value === false || String(value).toLowerCase() === 'false') return false
    throw new HttpError(400, `IF/ELSE node ${nodeId} contains an invalid Boolean operand`, 'INVALID_IF_ELSE_OPERAND')
  }
  if (type === 'Object' || type === 'Array') {
    let parsedValue = value
    try {
      if (typeof value === 'string') parsedValue = JSON.parse(value)
    } catch (error) {
      throw new HttpError(400, `IF/ELSE node ${nodeId} contains invalid JSON`, 'INVALID_IF_ELSE_OPERAND')
    }
    const valid = type === 'Array'
      ? Array.isArray(parsedValue)
      : parsedValue !== null && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
    if (!valid) {
      throw new HttpError(400, `IF/ELSE node ${nodeId} contains an invalid ${type} operand`, 'INVALID_IF_ELSE_OPERAND')
    }
    return parsedValue
  }
  return value
}

function resolveConditionOperand(operand, results, nodeId) {
  return operand?.valueType === 'reference'
    ? resolveReference(operand, results, nodeId)
    : parseConditionInput(operand, nodeId)
}

function isEmptyValue(value) {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'object' && Object.keys(value).length === 0
}

function containsValue(left, right) {
  if (typeof left === 'string') return left.includes(String(right))
  if (Array.isArray(left)) return left.some((item) => isDeepStrictEqual(item, right))
  if (left !== null && typeof left === 'object') {
    return typeof right === 'string' && Object.prototype.hasOwnProperty.call(left, right)
  }
  return false
}

function evaluateCondition(condition, results, nodeId) {
  const left = resolveConditionOperand(condition.left, results, nodeId)
  const operator = condition.operator || 'equals'
  if (operator === 'isEmpty') return isEmptyValue(left)
  if (operator === 'isNotEmpty') return !isEmptyValue(left)

  const right = resolveConditionOperand(condition.right, results, nodeId)
  switch (operator) {
    case 'equals': return isDeepStrictEqual(left, right)
    case 'notEquals': return !isDeepStrictEqual(left, right)
    case 'greaterThan': return left > right
    case 'greaterThanOrEqual': return left >= right
    case 'lessThan': return left < right
    case 'lessThanOrEqual': return left <= right
    case 'contains': return containsValue(left, right)
    case 'notContains': return !containsValue(left, right)
    default:
      throw new HttpError(400, `IF/ELSE node ${nodeId} uses unsupported operator ${operator}`, 'INVALID_IF_ELSE_OPERATOR')
  }
}

function evaluateIfElseNode(node, results) {
  const config = node.properties?.config || {}
  const conditions = (Array.isArray(config.conditions) ? config.conditions : [])
    .filter((condition) => condition?.enabled !== false)
  if (!conditions.length) {
    throw new HttpError(400, `IF/ELSE node ${node.id} has no enabled conditions`, 'IF_ELSE_CONDITION_NOT_CONFIGURED')
  }
  if (!['and', 'or'].includes(config.logic || 'and')) {
    throw new HttpError(400, `IF/ELSE node ${node.id} uses invalid condition logic`, 'INVALID_IF_ELSE_LOGIC')
  }

  const conditionResults = conditions.map((condition) => evaluateCondition(condition, results, node.id))
  const matched = (config.logic || 'and') === 'or'
    ? conditionResults.some(Boolean)
    : conditionResults.every(Boolean)
  return {
    branch: matched ? 'if' : 'else',
    conditionCount: conditions.length,
    conditionResults,
    logic: config.logic || 'and',
    matched,
  }
}

function getEdgeBranch(edge, sourceNodeId) {
  const configuredBranch = edge.properties?.branchId || edge.properties?.branch
  if (['if', 'true'].includes(configuredBranch)) return 'if'
  if (['else', 'false'].includes(configuredBranch)) return 'else'
  if (edge.sourceAnchorId === `${sourceNodeId}_1`) return 'if'
  if (edge.sourceAnchorId === `${sourceNodeId}_2`) return 'else'
  return null
}

function isIncomingEdgeActive(edge, executionStates, selectedBranches) {
  if (executionStates.get(edge.sourceNodeId) !== 'executed') return false
  const selectedBranch = selectedBranches.get(edge.sourceNodeId)
  return !selectedBranch || getEdgeBranch(edge, edge.sourceNodeId) === selectedBranch
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

function executeOutputNode(node, nodes, inputs, results, executionStates) {
  const properties = node.properties || {}
  const values = resolveParameters(properties.data, inputs, results, node.id, {
    allowSkippedReferences: true,
    executionStates,
  })
  const hasTextTemplate = Boolean(
    typeof properties.cueWord === 'string' && properties.cueWord.trim(),
  )
  const answer = hasTextTemplate
    ? interpolatePrompt(properties.cueWord, nodes, results, values)
    : ''

  return {
    values,
    answer,
    response: hasTextTemplate ? answer : values,
  }
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
    finishReason: response.finishReason,
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
  if (!nodes.some((node) => node.type === 'end-node' || node.type === 'output-node')) {
    throw new HttpError(400, 'Workflow has no end or output node', 'END_NODE_NOT_FOUND')
  }

  const results = new Map()
  const outputNodeResponses = new Map()
  const trace = []
  const executionOrder = getExecutionOrder(nodes, edges)
  const executionStates = new Map()
  const selectedBranches = new Map()
  for (const node of executionOrder) {
    const startedAt = Date.now()
    let output
    let metadata = {}
    const properties = node.properties || {}
    const incomingEdges = edges.filter((edge) => edge.targetNodeId === node.id)

    if (incomingEdges.length && !incomingEdges.some((edge) => (
      isIncomingEdgeActive(edge, executionStates, selectedBranches)
    ))) {
      executionStates.set(node.id, 'skipped')
      trace.push({
        nodeId: node.id,
        nodeType: node.type,
        title: properties.title || properties.label || node.type,
        status: 'skipped',
        reason: 'inactive_branch',
        durationMs: 0,
      })
      continue
    }

    if (node.type === 'start-node' || node.type === 'input-node') {
      output = resolveParameters(properties.data, inputs, results, node.id)
    } else if (node.type === 'http-node') {
      const httpResult = await executeHttpNode(node, results, invokeHttpNode)
      output = httpResult.output
      metadata = httpResult.metadata
    } else if (node.type === 'model-node') {
      let modelResult
      try {
        modelResult = await executeModelNode(node, nodes, inputs, results, invokeModel)
      } catch (error) {
        const nodeName = properties.title || properties.label || node.id
        error.message = `Model node ${nodeName} failed: ${error.message}`
        throw error
      }
      output = modelResult.output
      metadata = {
        model: modelResult.model,
        usage: modelResult.usage,
        finishReason: modelResult.finishReason,
        output: modelResult.output,
      }
    } else if (node.type === 'if-else-node') {
      const conditionResult = evaluateIfElseNode(node, results)
      const outgoingEdges = edges.filter((edge) => edge.sourceNodeId === node.id)
      if (outgoingEdges.some((edge) => !getEdgeBranch(edge, node.id))) {
        throw new HttpError(400, `IF/ELSE node ${node.id} has an edge without IF/ELSE branch information`, 'INVALID_IF_ELSE_BRANCH_EDGE')
      }
      if (!outgoingEdges.some((edge) => getEdgeBranch(edge, node.id) === conditionResult.branch)) {
        throw new HttpError(400, `IF/ELSE node ${node.id} selected an unconnected ${conditionResult.branch.toUpperCase()} branch`, 'IF_ELSE_BRANCH_NOT_CONNECTED')
      }
      selectedBranches.set(node.id, conditionResult.branch)
      output = {}
      metadata = { condition: conditionResult }
    } else if (node.type === 'output-node') {
      const outputResult = executeOutputNode(node, nodes, inputs, results, executionStates)
      output = outputResult.values
      outputNodeResponses.set(node.id, outputResult.response)
      metadata = {
        output: outputResult.values,
        answer: outputResult.answer,
      }
    } else if (node.type === 'end-node') {
      output = properties.outputMode === 'text' || properties.isCustomReply
        ? interpolatePrompt(properties.cueWord, nodes, results, {})
        : resolveParameters(properties.data, inputs, results, node.id, {
          allowSkippedReferences: true,
          executionStates,
        })
    } else {
      throw new HttpError(400, `Unsupported node type: ${node.type}`, 'UNSUPPORTED_NODE_TYPE')
    }

    results.set(node.id, output)
    executionStates.set(node.id, 'executed')
    trace.push({
      nodeId: node.id,
      nodeType: node.type,
      title: properties.title || properties.label || node.type,
      durationMs: Date.now() - startedAt,
      ...metadata,
    })
  }

  const executedEndNodes = executionOrder.filter((node) => (
    node.type === 'end-node' && executionStates.get(node.id) === 'executed'
  ))
  if (executedEndNodes.length) {
    const finalEndNode = executedEndNodes[executedEndNodes.length - 1]
    const output = results.get(finalEndNode.id)
    return { output, trace }
  }

  const executedOutputNodes = executionOrder.filter((node) => (
    node.type === 'output-node' && executionStates.get(node.id) === 'executed'
  ))
  if (!executedOutputNodes.length) {
    throw new HttpError(400, 'No end or output node was reached by the active branch', 'NO_ACTIVE_END_NODE')
  }
  const output = outputNodeResponses.get(executedOutputNodes[executedOutputNodes.length - 1].id)
  return { output, trace }
}

module.exports = { evaluateIfElseNode, getExecutionOrder, runWorkflow }
