const express = require('express')

const { checkDatabaseConnection } = require('../database')
const workflowRouter = require('./workflows')

const router = express.Router()

router.get('/', (req, res) => {
  res.json({
    code: 0,
    message: 'LogicFlow API is ready',
  })
})

router.get('/health', (req, res) => {
  res.json({
    code: 0,
    data: {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  })
})

router.get('/health/database', async (req, res, next) => {
  try {
    const connected = await checkDatabaseConnection()

    res.json({
      code: 0,
      data: {
        status: connected ? 'ok' : 'error',
      },
    })
  } catch (error) {
    error.status = 503
    error.message = `Database connection failed: ${error.message}`
    next(error)
  }
})

router.use('/workflows', workflowRouter)

module.exports = router
