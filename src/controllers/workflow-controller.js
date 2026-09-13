const workflowService = require('../services/workflow-service')
const workflowRunService = require('../services/workflow-run-service')
const httpNodeTestRunService = require('../services/http-node-test-run-service')
const { runWorkflow: executeWorkflow } = require('../services/workflow-runner')
const { buildOutputOptions, testHttpNode: executeHttpNodeTest } = require('../services/http-node-service')
const HttpError = require('../utils/http-error')

function getInputDefinitions(graphData) {
  return (graphData.nodes || [])
    .filter((node) => node.type === 'start-node' || node.type === 'input-node')
    .flatMap((node) => (Array.isArray(node.properties?.data) ? node.properties.data : []).map((item) => ({
      id: item.id,
      nodeId: node.id,
      nodeType: node.type,
      name: item.name,
      description: item.description || '',
      type: item.type || 'String',
      required: item.required !== false,
      defaultValue: item.defaultValue ?? '',
    })))
}

async function getWorkflow(req, res, next) {
  try {
    const workflow = await workflowService.getWorkflow(req.params.workflowKey)
    res.json({ code: 0, data: workflow })
  } catch (error) {
    next(error)
  }
}

async function saveWorkflow(req, res, next) {
  try {
    const workflow = await workflowService.saveWorkflow(req.params.workflowKey, req.body)
    res.json({ code: 0, message: 'Workflow saved', data: workflow })
  } catch (error) {
    next(error)
  }
}

async function runWorkflow(req, res, next) {
  let runId
  const startedAt = Date.now()
  try {
    const workflow = await workflowService.getWorkflow(req.params.workflowKey)
    const inputs = req.body.inputs || {}
    runId = await workflowRunService.createRun(
      workflow.id,
      workflow.version,
      inputs,
      req.body.runMode,
    )
    const result = await executeWorkflow(workflow.graphData, inputs)
    const durationMs = Date.now() - startedAt
    await workflowRunService.completeRun(runId, result, durationMs)

    res.json({
      code: 0,
      message: 'Workflow completed',
      data: {
        runId,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        durationMs,
        ...result,
      },
    })
  } catch (error) {
    if (runId) {
      try {
        await workflowRunService.failRun(runId, error, Date.now() - startedAt)
      } catch (recordError) {
        console.error('Failed to update workflow run record:', recordError)
      }
    }
    next(error)
  }
}

async function listWorkflowRuns(req, res, next) {
  try {
    const data = await workflowRunService.listRuns(
      req.params.workflowKey,
      Number.parseInt(req.query.page || '1', 10),
      Number.parseInt(req.query.pageSize || '20', 10),
    )
    res.json({ code: 0, data })
  } catch (error) {
    next(error)
  }
}

async function getWorkflowRun(req, res, next) {
  try {
    const data = await workflowRunService.getRun(req.params.workflowKey, req.params.runId)
    res.json({ code: 0, data })
  } catch (error) {
    next(error)
  }
}

async function getLatestWorkflowRun(req, res, next) {
  try {
    const data = await workflowRunService.getLatestRun(req.params.workflowKey)
    res.json({ code: 0, data })
  } catch (error) {
    next(error)
  }
}

async function getWorkflowRunConfig(req, res, next) {
  try {
    const workflow = await workflowService.getWorkflow(req.params.workflowKey)
    let latestRun = null

    try {
      latestRun = await workflowRunService.getLatestRun(req.params.workflowKey)
    } catch (error) {
      if (error.code !== 'WORKFLOW_RUN_NOT_FOUND') throw error
    }

    res.json({
      code: 0,
      data: {
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        inputDefinitions: getInputDefinitions(workflow.graphData),
        latestRun,
      },
    })
  } catch (error) {
    next(error)
  }
}

async function testHttpNode(req, res, next) {
  try {
    await workflowService.getWorkflow(req.params.workflowKey)
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new HttpError(400, 'Request body must be an object', 'INVALID_HTTP_NODE_TEST_DATA')
    }
    const data = await executeHttpNodeTest({
      config: req.body.config,
      output: req.body.output || [],
      variables: req.body.variables || {},
    })
    res.json({ code: 0, message: 'HTTP node test completed', data })
  } catch (error) {
    next(error)
  }
}

async function testAndSaveHttpNode(req, res, next) {
  try {
    await workflowService.getWorkflow(req.params.workflowKey)
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new HttpError(400, 'Request body must be an object', 'INVALID_HTTP_NODE_TEST_DATA')
    }
    const variables = req.body.variables || {}
    const result = await executeHttpNodeTest({
      config: req.body.config,
      output: req.body.output || [],
      variables,
    })
    const outputOptions = buildOutputOptions(result.response.body)
    const testRunId = await httpNodeTestRunService.createHttpNodeTestRun(
      req.params.workflowKey,
      req.params.nodeId,
      variables,
      result,
      outputOptions,
    )

    res.json({
      code: 0,
      message: 'HTTP node test completed and saved',
      data: { ...result, testRunId, nodeId: req.params.nodeId, outputOptions },
    })
  } catch (error) {
    next(error)
  }
}

async function getLatestHttpNodeTestRun(req, res, next) {
  try {
    await workflowService.getWorkflow(req.params.workflowKey)
    const data = await httpNodeTestRunService.getLatestHttpNodeTestRun(
      req.params.workflowKey,
      req.params.nodeId,
    )
    res.json({ code: 0, data })
  } catch (error) {
    next(error)
  }
}

module.exports = {
  getWorkflow,
  getLatestWorkflowRun,
  getWorkflowRun,
  getWorkflowRunConfig,
  getLatestHttpNodeTestRun,
  listWorkflowRuns,
  runWorkflow,
  saveWorkflow,
  testAndSaveHttpNode,
  testHttpNode,
}
