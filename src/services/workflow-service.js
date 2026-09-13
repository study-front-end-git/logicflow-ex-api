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

  if (name.length > 100) {
    throw new HttpError(400, 'name cannot exceed 100 characters', 'INVALID_WORKFLOW_NAME')
  }
  if (description && description.length > 500) {
    throw new HttpError(400, 'description cannot exceed 500 characters', 'INVALID_WORKFLOW_DESCRIPTION')
  }
  if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    throw new HttpError(400, 'version must be a positive integer', 'INVALID_VERSION')
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
      await connection.execute(
        `INSERT INTO workflows (workflow_key, name, description, graph_data)
         VALUES (?, ?, ?, ?)`,
        [workflowKey, name, description, JSON.stringify(graphData)],
      )
    } else {
      const currentVersion = existingRows[0].version
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new HttpError(409, `Workflow has changed; current version is ${currentVersion}`, 'VERSION_CONFLICT')
      }
      await connection.execute(
        `UPDATE workflows
            SET name = ?, description = ?, graph_data = ?, version = version + 1
          WHERE id = ?`,
        [name, description, JSON.stringify(graphData), existingRows[0].id],
      )
    }

    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }

  return getWorkflow(workflowKey)
}

module.exports = {
  getWorkflow,
  saveWorkflow,
}
