const { randomUUID } = require('node:crypto')

const { pool } = require('../database')
const HttpError = require('../utils/http-error')
const { validateWorkflowKey } = require('../validators/workflow')

function parseJson(value) {
  if (value === null || value === undefined || typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch (error) {
    return value
  }
}

function validateNodeKey(nodeKey) {
  if (typeof nodeKey !== 'string' || !nodeKey.trim()) {
    throw new HttpError(400, 'HTTP node id is required', 'INVALID_HTTP_NODE_ID')
  }
  if (nodeKey.length > 255) {
    throw new HttpError(400, 'HTTP node id cannot exceed 255 characters', 'INVALID_HTTP_NODE_ID')
  }
  return nodeKey.trim()
}

function mapTestRun(row) {
  return {
    id: row.test_run_key,
    workflowId: row.workflow_key,
    nodeId: row.node_key,
    variables: parseJson(row.variables),
    request: parseJson(row.request_data),
    response: parseJson(row.response_data),
    output: parseJson(row.output_data),
    outputOptions: parseJson(row.output_options),
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }
}

async function createHttpNodeTestRun(workflowKey, nodeKey, variables, result, outputOptions) {
  validateWorkflowKey(workflowKey)
  const normalizedNodeKey = validateNodeKey(nodeKey)
  const testRunKey = randomUUID()
  const [insertResult] = await pool.execute(
    `INSERT INTO http_node_test_runs
       (test_run_key, workflow_id, node_key, variables, request_data, response_data,
        output_data, output_options, duration_ms)
     SELECT ?, id, ?, ?, ?, ?, ?, ?, ?
       FROM workflows
      WHERE workflow_key = ?`,
    [
      testRunKey,
      normalizedNodeKey,
      JSON.stringify(variables || {}),
      JSON.stringify(result.request || {}),
      JSON.stringify(result.response || {}),
      JSON.stringify(result.output || {}),
      JSON.stringify(outputOptions || []),
      result.response?.durationMs ?? null,
      workflowKey,
    ],
  )

  if (!insertResult.affectedRows) {
    throw new HttpError(404, 'Workflow not found', 'WORKFLOW_NOT_FOUND')
  }
  return testRunKey
}

async function getLatestHttpNodeTestRun(workflowKey, nodeKey) {
  validateWorkflowKey(workflowKey)
  const normalizedNodeKey = validateNodeKey(nodeKey)
  const [rows] = await pool.execute(
    `SELECT r.test_run_key, w.workflow_key, r.node_key, r.variables,
            r.request_data, r.response_data, r.output_data, r.output_options,
            r.duration_ms, r.created_at
       FROM http_node_test_runs r
       JOIN workflows w ON w.id = r.workflow_id
      WHERE w.workflow_key = ? AND r.node_key = ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 1`,
    [workflowKey, normalizedNodeKey],
  )

  return rows.length ? mapTestRun(rows[0]) : null
}

module.exports = { createHttpNodeTestRun, getLatestHttpNodeTestRun }
