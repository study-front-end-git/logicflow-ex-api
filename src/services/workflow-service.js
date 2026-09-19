const { randomUUID } = require('node:crypto')

const { pool } = require('../database')
const HttpError = require('../utils/http-error')
const { validateGraphData, validateWorkflowKey } = require('../validators/workflow')

function mapWorkflow(row) {
  return {
    id: row.workflow_key,
    name: row.name,
    description: row.description,
    graphData: typeof row.graph_data === 'string' ? JSON.parse(row.graph_data) : row.graph_data,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  }
}

function mapWorkflowSummary(row) {
  return {
    id: row.workflow_key,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  }
}

async function listWorkflows() {
  const [rows] = await pool.execute(
    `SELECT workflow_key, name, description, status, version, created_by,
            created_at, updated_at, published_at
       FROM workflows
      ORDER BY updated_at DESC, id DESC`,
  )

  return rows.map(mapWorkflowSummary)
}

async function createWorkflow(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Request body must be an object', 'INVALID_WORKFLOW_DATA')
  }

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) {
    throw new HttpError(400, 'name is required', 'WORKFLOW_NAME_REQUIRED')
  }

  const workflowKey = randomUUID()
  return saveWorkflow(workflowKey, {
    name,
    description: input.description,
    graphData: input.graphData ?? { nodes: [], edges: [] },
    createVersion: false,
  })
}

async function deleteWorkflow(workflowKey) {
  validateWorkflowKey(workflowKey)
  const [result] = await pool.execute(
    'DELETE FROM workflows WHERE workflow_key = ?',
    [workflowKey],
  )

  if (!result.affectedRows) {
    throw new HttpError(404, 'Workflow not found', 'WORKFLOW_NOT_FOUND')
  }

  return { id: workflowKey }
}

async function getWorkflow(workflowKey) {
  validateWorkflowKey(workflowKey)
  const [rows] = await pool.execute(
    `SELECT workflow_key, name, description, graph_data, status, version,
            created_at, updated_at, published_at
       FROM workflows
      WHERE workflow_key = ?`,
    [workflowKey],
  )

  if (!rows.length) {
    throw new HttpError(404, 'Workflow not found', 'WORKFLOW_NOT_FOUND')
  }

  return mapWorkflow(rows[0])
}

async function saveWorkflow(workflowKey, input) {
  validateWorkflowKey(workflowKey)
  const graphData = validateGraphData(input.graphData)
  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim()
    : 'Untitled workflow'
  const description = typeof input.description === 'string' ? input.description.trim() || null : null
  const expectedVersion = input.version
  const createVersion = input.createVersion === true
  const changeNote = typeof input.changeNote === 'string' ? input.changeNote.trim() || null : null

  if (name.length > 100) {
    throw new HttpError(400, 'name cannot exceed 100 characters', 'INVALID_WORKFLOW_NAME')
  }
  if (description && description.length > 500) {
    throw new HttpError(400, 'description cannot exceed 500 characters', 'INVALID_WORKFLOW_DESCRIPTION')
  }
  if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    throw new HttpError(400, 'version must be a positive integer', 'INVALID_VERSION')
  }
  if (input.createVersion !== undefined && typeof input.createVersion !== 'boolean') {
    throw new HttpError(400, 'createVersion must be a boolean', 'INVALID_CREATE_VERSION')
  }
  if (changeNote && changeNote.length > 500) {
    throw new HttpError(400, 'changeNote cannot exceed 500 characters', 'INVALID_CHANGE_NOTE')
  }

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [existingRows] = await connection.execute(
      'SELECT id, version FROM workflows WHERE workflow_key = ? FOR UPDATE',
      [workflowKey],
    )

    if (!existingRows.length) {
      if (expectedVersion !== undefined) {
        throw new HttpError(409, 'Workflow does not exist yet; omit version when creating it', 'VERSION_CONFLICT')
      }
      const [insertResult] = await connection.execute(
        `INSERT INTO workflows (workflow_key, name, description, graph_data)
         VALUES (?, ?, ?, ?)`,
        [workflowKey, name, description, JSON.stringify(graphData)],
      )
      if (createVersion) {
        await connection.execute(
          `INSERT INTO workflow_versions (workflow_id, version, graph_data, change_note)
           VALUES (?, 1, ?, ?)`,
          [insertResult.insertId, JSON.stringify(graphData), changeNote],
        )
      }
    } else {
      const workflowId = existingRows[0].id
      const currentVersion = existingRows[0].version
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new HttpError(409, `Workflow has changed; current version is ${currentVersion}`, 'VERSION_CONFLICT')
      }

      let nextVersion = currentVersion
      if (createVersion) {
        const [versionRows] = await connection.execute(
          'SELECT id FROM workflow_versions WHERE workflow_id = ? AND version = ? LIMIT 1',
          [workflowId, currentVersion],
        )
        nextVersion = versionRows.length ? currentVersion + 1 : currentVersion
      }

      await connection.execute(
        `UPDATE workflows
            SET name = ?, description = ?, graph_data = ?, version = ?
          WHERE id = ?`,
        [name, description, JSON.stringify(graphData), nextVersion, workflowId],
      )

      if (createVersion) {
        await connection.execute(
          `INSERT INTO workflow_versions (workflow_id, version, graph_data, change_note)
           VALUES (?, ?, ?, ?)`,
          [workflowId, nextVersion, JSON.stringify(graphData), changeNote],
        )
      }
    }

    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }

  const workflow = await getWorkflow(workflowKey)
  return { ...workflow, savedAsVersion: createVersion }
}

module.exports = {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  saveWorkflow,
}
