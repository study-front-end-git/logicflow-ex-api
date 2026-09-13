const HttpError = require('../utils/http-error')

function validateWorkflowKey(workflowKey) {
  if (!workflowKey || workflowKey.length > 64) {
    throw new HttpError(400, 'workflowKey must contain 1 to 64 characters', 'INVALID_WORKFLOW_KEY')
  }
}

function validateGraphData(graphData) {
  if (!graphData || typeof graphData !== 'object' || Array.isArray(graphData)) {
    throw new HttpError(400, 'graphData must be an object', 'INVALID_GRAPH_DATA')
  }

  if (!Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges)) {
    throw new HttpError(400, 'graphData.nodes and graphData.edges must be arrays', 'INVALID_GRAPH_DATA')
  }

  const nodeIds = new Set()
  for (const node of graphData.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || typeof node.type !== 'string' || !node.type) {
      throw new HttpError(400, 'Every node must have a string id and type', 'INVALID_NODE')
    }
    if (nodeIds.has(node.id)) {
      throw new HttpError(400, `Duplicate node id: ${node.id}`, 'DUPLICATE_NODE_ID')
    }
    nodeIds.add(node.id)
  }

  const edgeIds = new Set()
  for (const edge of graphData.edges) {
    if (!edge || typeof edge.id !== 'string' || !edge.id) {
      throw new HttpError(400, 'Every edge must have a string id', 'INVALID_EDGE')
    }
    if (edgeIds.has(edge.id)) {
      throw new HttpError(400, `Duplicate edge id: ${edge.id}`, 'DUPLICATE_EDGE_ID')
    }
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      throw new HttpError(400, `Edge ${edge.id} references a missing node`, 'INVALID_EDGE_REFERENCE')
    }
    edgeIds.add(edge.id)
  }

  return graphData
}

module.exports = {
  validateGraphData,
  validateWorkflowKey,
}
