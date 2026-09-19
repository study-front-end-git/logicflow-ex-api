const express = require('express')

const workflowController = require('../controllers/workflow-controller')

const router = express.Router()

router.get('/', workflowController.listWorkflows)
router.post('/', workflowController.createWorkflow)
router.get('/:workflowKey', workflowController.getWorkflow)
router.put('/:workflowKey', workflowController.saveWorkflow)
router.delete('/:workflowKey', workflowController.deleteWorkflow)
router.get('/:workflowKey/run-config', workflowController.getWorkflowRunConfig)
router.post('/:workflowKey/run', workflowController.runWorkflow)
router.post('/:workflowKey/http-nodes/test', workflowController.testHttpNode)
router.post('/:workflowKey/http-nodes/:nodeId/test-runs', workflowController.testAndSaveHttpNode)
router.get('/:workflowKey/http-nodes/:nodeId/test-runs', workflowController.getLatestHttpNodeTestRun)
router.get('/:workflowKey/http-nodes/:nodeId/test-runs/latest', workflowController.getLatestHttpNodeTestRun)
router.get('/:workflowKey/runs', workflowController.listWorkflowRuns)
router.get('/:workflowKey/runs/latest', workflowController.getLatestWorkflowRun)
router.get('/:workflowKey/runs/:runId', workflowController.getWorkflowRun)

module.exports = router
