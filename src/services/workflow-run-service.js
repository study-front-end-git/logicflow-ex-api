const { randomUUID } = require('node:crypto')

const { pool } = require('../database')
const HttpError = require('../utils/http-error')
const { validateWorkflowKey } = require('../validators/workflow')

function parseJson(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value)
  } catch (error) {
    // mysql2 may already deserialize a JSON string scalar into plain text.
    return value
  }
}

function mapRun(row) {
  return {
    id: row.run_key,
    workflowId: row.workflow_key,
    workflowVersion: row.workflow_version,
    runMode: row.run_mode,
    status: row.status,
    inputs: parseJson(row.inputs),
    output: parseJson(row.output),
    trace: parseJson(row.trace),
    error: row.error_code
      ? { code: row.error_code, message: row.error_message }
      : null,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

async function createRun(workflowKey, workflowVersion, inputs, runMode = 'debug') {
  const runKey = randomUUID()
  const normalizedMode = typeof runMode === 'string' && runMode.trim()
    ? runMode.trim().slice(0, 20)
    : 'debug'
  const [result] = await pool.execute(
    `INSERT INTO workflow_runs
       (run_key, workflow_id, workflow_version, run_mode, status, inputs)
     SELECT ?, id, ?, ?, 'running', ?
       FROM workflows
      WHERE workflow_key = ?`,
    [runKey, workflowVersion, normalizedMode, JSON.stringify(inputs), workflowKey],
  )
  if (!result.affectedRows) {
    throw new HttpError(404, 'Workflow not found', 'WORKFLOW_NOT_FOUND')
  }
  return runKey
}

async function completeRun(runKey, result, durationMs) {
  await pool.execute(
    `UPDATE workflow_runs
        SET status = 'success', output = ?, trace = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP(3)
      WHERE run_key = ?`,
    [JSON.stringify(result.output), JSON.stringify(result.trace), durationMs, runKey],
  )
}

async function failRun(runKey, error, durationMs) {
  await pool.execute(
    `UPDATE workflow_runs
        SET status = 'failed', error_code = ?, error_message = ?, duration_ms = ?,
            completed_at = CURRENT_TIMESTAMP(3)
      WHERE run_key = ?`,
    [String(error.code || error.status || 'WORKFLOW_RUN_FAILED'), String(error.message || 'Workflow run failed').slice(0, 1000), durationMs, runKey],
  )
}

async function getRun(workflowKey, runKey) {
  validateWorkflowKey(workflowKey)
  const [rows] = await pool.execute(
    `SELECT r.run_key, w.workflow_key, r.workflow_version, r.run_mode, r.status,
            r.inputs, r.output, r.trace, r.error_code, r.error_message,
            r.duration_ms, r.started_at, r.completed_at
       FROM workflow_runs r
       JOIN workflows w ON w.id = r.workflow_id
      WHERE w.workflow_key = ? AND r.run_key = ?`,
    [workflowKey, runKey],
  )
  if (!rows.length) throw new HttpError(404, 'Workflow run not found', 'WORKFLOW_RUN_NOT_FOUND')
  return mapRun(rows[0])
}

async function getLatestRun(workflowKey) {
  validateWorkflowKey(workflowKey)
  const [rows] = await pool.execute(
    `SELECT r.run_key, w.workflow_key, r.workflow_version, r.run_mode, r.status,
            r.inputs, r.output, r.trace, r.error_code, r.error_message,
            r.duration_ms, r.started_at, r.completed_at
       FROM workflow_runs r
       JOIN workflows w ON w.id = r.workflow_id
      WHERE w.workflow_key = ?
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT 1`,
    [workflowKey],
  )
  if (!rows.length) {
    throw new HttpError(404, 'Workflow has no run records', 'WORKFLOW_RUN_NOT_FOUND')
  }
  return mapRun(rows[0])
}

async function listRuns(workflowKey, page = 1, pageSize = 20) {
  validateWorkflowKey(workflowKey)
  const safePage = Number.isInteger(page) && page > 0 ? page : 1
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0
    ? Math.min(pageSize, 100)
    : 20
  const offset = (safePage - 1) * safePageSize
  const [[countRow], [rows]] = await Promise.all([
    pool.execute(
      `SELECT COUNT(*) AS total
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
        WHERE w.workflow_key = ?`,
      [workflowKey],
    ).then(([result]) => result),
    pool.execute(
      `SELECT r.run_key, w.workflow_key, r.workflow_version, r.run_mode, r.status,
              r.inputs, r.output, r.trace, r.error_code, r.error_message,
              r.duration_ms, r.started_at, r.completed_at
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
        WHERE w.workflow_key = ?
        ORDER BY r.started_at DESC
        LIMIT ? OFFSET ?`,
      [workflowKey, safePageSize, offset],
    ),
  ])

  return {
    items: rows.map(mapRun),
    pagination: { page: safePage, pageSize: safePageSize, total: Number(countRow.total) },
  }
}

module.exports = { completeRun, createRun, failRun, getLatestRun, getRun, listRuns }
